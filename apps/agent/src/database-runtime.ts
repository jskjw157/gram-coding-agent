import { Socket } from 'node:net';
import { createConnection, type Connection, type ConnectionConfig, type Prepare, type FieldInfo } from 'mariadb';
import { DatabaseSelectInput, type DatabaseScalar, type DatabaseSelectView, type ReadOnlyDatabaseToolsPort } from '@gram/mcp';
import { SecretRedactor, type SecretProvider } from '@gram/secrets';
import type { DatabaseConnectionConfig, ReadonlyDatabaseConfig } from './database-config.js';
import { assertReadOnlySelect } from './database-select-policy.js';

export interface DatabaseRuntimeOptions { config: ReadonlyDatabaseConfig; secrets: SecretProvider; redactor: SecretRedactor }
export interface DatabaseRuntime { tools: ReadOnlyDatabaseToolsPort; close(): Promise<void> }
const denied = () => new Error('Database operation denied or failed');
const MODE = 'STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION,IGNORE_SPACE';

function options(profile: DatabaseConnectionConfig, password: string): ConnectionConfig {
  return { host: profile.host, port: profile.port, database: profile.database, user: profile.user, password,
    ssl: profile.tls === false ? false : { ...profile.tls, rejectUnauthorized: true },
    connectTimeout: Math.min(profile.timeoutMs, 5000), multipleStatements: false, permitLocalInfile: false,
    allowPublicKeyRetrieval: false, rowsAsArray: true, dateStrings: true, autoJsonMap: false,
    bigIntAsNumber: false, decimalAsNumber: false, maxAllowedPacket: 4194304, maxAllowedColumns: 128,
    logParam: false, trace: false, debug: false };
}

async function metadata(connection: Connection, sql: string, failTransport: () => void, command = false): Promise<unknown[][]> {
  return await new Promise((resolve, reject) => {
    const rows: unknown[][] = [];
    const stream = connection.queryStream(sql);
    let bytes = 0, settled = false, okSeen = false, fieldsSeen = false;
    const finish = (error?: Error) => { if (!settled) { settled = true; if (error) reject(error); else resolve(rows); } };
    stream.on('error', () => finish(denied()));
    stream.on('end', () => {
      if (command && !okSeen) { failTransport(); finish(denied()); } else finish();
    });
    stream.on('fields', () => { fieldsSeen = true; if (command) { failTransport(); finish(denied()); } });
    stream.on('data', (row: unknown) => {
      if (settled) return;
      try {
        if (command) {
          if (okSeen || fieldsSeen || row === null || typeof row !== 'object' || Array.isArray(row) ||
              Object.keys(row).sort().join(',') !== 'affectedRows,insertId,warningStatus') throw denied();
          const packet = row as { affectedRows: unknown; insertId: unknown; warningStatus: unknown };
          if (packet.affectedRows !== 0 || packet.insertId !== 0n && packet.insertId !== 0 || packet.warningStatus !== 0) throw denied();
          okSeen = true; return;
        }
        if (!Array.isArray(row) || row.length > 128 || rows.length >= 256) throw denied();
        for (const value of row) {
          if (value !== null && !['string', 'number', 'bigint', 'boolean'].includes(typeof value)) throw denied();
          bytes += Buffer.byteLength(String(value)) + 8;
          if (bytes > 65536) throw denied();
        }
        rows.push(row);
      } catch { failTransport(); finish(denied()); }
    });
  });
}

async function identity(connection: Connection, engine: DatabaseConnectionConfig['engine'], failTransport: () => void): Promise<string[]> {
  const uid = engine === 'mysql' ? '@@server_uuid' : '@@server_uid';
  const rows = await metadata(connection, `SELECT CONNECTION_ID(), ${uid}, CURRENT_USER(), VERSION()`, failTransport);
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0]) || rows[0].length !== 4) throw denied();
  const values = rows[0].map(String);
  if (values[0] !== String(connection.threadId) || !Number.isSafeInteger(connection.threadId) ||
      Number(connection.threadId) < 1 || !values[1] || !values[2] ||
      (engine === 'mariadb') !== /mariadb/iu.test(values[3] ?? '')) throw denied();
  return values;
}

async function requireReadOnlyAccount(connection: Connection, failTransport: () => void): Promise<void> {
  const rows = await metadata(connection, 'SHOW GRANTS', failTransport);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 256) throw denied();
  let selected = false;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 1 || typeof row[0] !== 'string') throw denied();
    const grant = row[0];
    const match = /^GRANT (.+?) ON .+? TO /iu.exec(grant);
    if (!match || /\bWITH GRANT OPTION\b/iu.test(grant)) throw denied();
    for (const privilege of (match[1] ?? '').split(',').map(value => value.trim().toUpperCase())) {
      if (!['USAGE', 'SELECT', 'SHOW VIEW'].includes(privilege)) throw denied();
      if (privilege === 'SELECT') selected = true;
    }
  }
  if (!selected) throw denied();
}

function scalar(value: unknown, password: string, local: SecretRedactor, global: SecretRedactor): DatabaseScalar {
  if (Buffer.isBuffer(value)) {
    const text = value.toString('utf8');
    if (value.includes(Buffer.from(password)) || global.redact(local.redact(text)) !== text) return '***REDACTED***';
    return global.redact(local.redact('base64:' + value.toString('base64')));
  }
  if (value === null) return null;
  if (typeof value === 'bigint') value = value.toString();
  if (typeof value === 'string') return global.redact(local.redact(value));
  if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') {
    const screened = global.redact(local.redact(String(value)));
    return screened === String(value) ? value as number | boolean : screened;
  }
  throw denied();
}

async function execute(profile: DatabaseConnectionConfig, sql: string, parameters: readonly DatabaseScalar[],
  password: string, signal: AbortSignal, redactor: SecretRedactor, quarantine: () => void): Promise<DatabaseSelectView> {
  if (!password || Buffer.byteLength(password) > 16384) throw denied();
  const local = new SecretRedactor([password, Buffer.from(password).toString('base64'), encodeURIComponent(password)]);
  let target: Connection | undefined, control: Connection | undefined, statement: Prepare | undefined;
  const sockets = new Set<Socket>();
  let hardCleanup: ReturnType<typeof setTimeout> | undefined;
  let verified = false, stop: Promise<void> | undefined;
  const closeTransport = (uncertain = false) => {
    if (uncertain) quarantine();
    for (const socket of sockets) socket.destroy(denied());
  };
  const connect = () => createConnection({ ...options(profile, password), stream: callback => {
    const socket = new Socket(); sockets.add(socket);
    socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    callback(undefined, socket);
    if (signal.aborted) socket.destroy(denied());
    else socket.connect(profile.port, profile.host);
  } });
  const failTransport = () => closeTransport(true);
  let reason: 'limit' | 'overflow' | 'abort' | 'failure' | undefined;
  let finish: ((error?: Error) => void) | undefined;
  const result: DatabaseSelectView = { columns: [], rows: [], truncated: false };
  let view: DatabaseSelectView | undefined, failed = false;
  let bytes = 0;
  const stopQuery = (why: NonNullable<typeof reason>): Promise<void> => {
    if (stop) return stop;
    reason = why;
    stop = (async () => {
      if (!target || !control || !verified) throw denied();
      // Keep the target owned until the KILL and its FIFO rollback barrier finish.
      try { await metadata(control, `KILL QUERY ${target.threadId}`, failTransport, true); } catch { /* The barrier must still prove termination. */ }
      try { await metadata(target, 'ROLLBACK', failTransport, true); }
      catch {
        const processes = await metadata(control, 'SHOW PROCESSLIST', failTransport);
        if (!Array.isArray(processes) || processes.some(row => String(row[0]) === String(target?.threadId) && String(row[4]) !== 'Sleep')) throw denied();
      }
    })();
    void stop.then(() => finish?.(why === 'limit' ? undefined : denied()), () => { quarantine(); finish?.(denied()); });
    return stop;
  };
  const abort = () => {
    if (!verified) { closeTransport(); return; }
    hardCleanup = setTimeout(() => closeTransport(true), 5000); hardCleanup.unref();
    void stopQuery('abort');
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    control = await connect();
    control.on('error', () => {});
    signal.throwIfAborted();
    target = await connect();
    target.on('error', () => {});
    signal.throwIfAborted();
    const controlIdentity = await identity(control, profile.engine, failTransport);
    signal.throwIfAborted();
    const targetIdentity = await identity(target, profile.engine, failTransport);
    if (controlIdentity[1] !== targetIdentity[1] || controlIdentity[2] !== targetIdentity[2] ||
        controlIdentity[0] === targetIdentity[0]) throw denied();
    verified = true; signal.throwIfAborted();
    await requireReadOnlyAccount(target, failTransport); signal.throwIfAborted();
    await metadata(target, `SET SESSION sql_mode = '${MODE}'`, failTransport, true); signal.throwIfAborted();
    await metadata(target, profile.engine === 'mysql' ? `SET SESSION max_execution_time = ${profile.timeoutMs}` :
      `SET SESSION max_statement_time = ${profile.timeoutMs / 1000}`, failTransport, true); signal.throwIfAborted();
    await metadata(target, 'START TRANSACTION READ ONLY', failTransport, true); signal.throwIfAborted();
    statement = await target.prepare(sql); signal.throwIfAborted();
    const stream = statement.executeStream([...parameters]);
    await new Promise<void>((resolve, reject) => {
      let settled = false, fieldsSeen = false;
      finish = error => { if (!settled) { settled = true; if (error) reject(error); else resolve(); } };
      stream.on('error', () => { if (!reason) void stopQuery('failure'); });
      stream.on('end', () => { if (!reason) finish?.(); });
      stream.on('fields', (fields: FieldInfo[]) => {
        try {
          if (fieldsSeen || !Array.isArray(fields) || fields.length < 1 || fields.length > 128) throw denied();
          fieldsSeen = true;
          result.columns = fields.map(field => globalString(field.name(), local, redactor));
          bytes = Buffer.byteLength(JSON.stringify(result));
          if (bytes > profile.maxBytes) throw denied();
        } catch { void stopQuery('failure'); }
      });
      stream.on('data', (row: unknown) => {
        if (reason) return;
        try {
          if (!fieldsSeen || !Array.isArray(row) || row.length !== result.columns.length) throw denied();
          if (result.rows.length === profile.maxRows) { result.truncated = true; void stopQuery('limit'); return; }
          const values = row.map(value => scalar(value, password, local, redactor));
          const size = Buffer.byteLength(JSON.stringify(values)) + (result.rows.length > 0 ? 1 : 0);
          if (bytes + size > profile.maxBytes) { void stopQuery('overflow'); return; }
          bytes += size; result.rows.push(values);
        } catch { void stopQuery('failure'); }
      });
    });
    if (stop) await stop;
    signal.throwIfAborted();
    if (reason && reason !== 'limit' || result.columns.length === 0) throw denied();
    view = result;
  } catch { failed = true; } finally {
    let clean = true;
    if (stop) { try { await stop; } catch { clean = false; } }
    if (target) {
      try { if (target.isValid()) await metadata(target, 'ROLLBACK', failTransport, true); }
      catch { clean = false; }
      try { statement?.close(); await target.end(); } catch { clean = false; }
    }
    if (control) { try { await control.end(); } catch { clean = false; } }
    if (stop) { try { await stop; } catch { clean = false; } }
    await Promise.all([...sockets].map(socket => new Promise<void>(resolve => { socket.once('close', () => resolve()); socket.destroy(); })));
    clearTimeout(hardCleanup);
    signal.removeEventListener('abort', abort);
    if (!clean) { quarantine(); failed = true; }
  }
  if (failed || view === undefined || signal.aborted) throw denied();
  return view;
}

function globalString(value: unknown, local: SecretRedactor, global: SecretRedactor): string {
  if (typeof value !== 'string') throw denied();
  return global.redact(local.redact(value));
}

export function createDatabaseRuntime(options: DatabaseRuntimeOptions): DatabaseRuntime {
  const profiles = new Map(options.config.connections.map(profile => [profile.id, profile]));
  const active = new Set<{ controller: AbortController; done: Promise<unknown> }>();
  let closed = false, quarantined = false, closePromise: Promise<void> | undefined;
  const quarantine = () => {
    if (!quarantined) process.stderr.write('Database cleanup could not confirm quiescence; new database queries are disabled.\n');
    quarantined = true;
  };
  const tools: ReadOnlyDatabaseToolsPort = {
    connections: async () => [...profiles.values()].map(({ id, engine }) => ({ connectionId: id, engine })),
    select: async (raw, callerSignal) => {
      try {
        callerSignal.throwIfAborted();
        const input = DatabaseSelectInput.parse(raw);
        const profile = profiles.get(input.connectionId);
        if (closed || quarantined || !profile || active.size >= 2) throw denied();
        assertReadOnlySelect(input.sql);
        const entry = { controller: new AbortController(), done: Promise.resolve<unknown>(undefined) };
        const signal = AbortSignal.any([callerSignal, entry.controller.signal]);
        const timer = setTimeout(() => entry.controller.abort(), profile.timeoutMs); timer.unref();
        active.add(entry);
        entry.done = Promise.resolve().then(async () => {
          let lease;
          try {
            signal.throwIfAborted();
            lease = await options.secrets.getForUse(profile.passwordSecret);
            signal.throwIfAborted();
            return await lease.withValue(password => execute(profile, input.sql, input.parameters ?? [], password,
              signal, options.redactor, quarantine));
          } finally { lease?.dispose(); clearTimeout(timer); active.delete(entry); }
        });
        return await entry.done as DatabaseSelectView;
      } catch { throw denied(); }
    },
  };
  return { tools, close: () => {
    if (!closePromise) { closed = true; for (const entry of active) entry.controller.abort();
      closePromise = Promise.allSettled([...active].map(entry => entry.done)).then(() => { if (quarantined) throw denied(); }); }
    return closePromise;
  } };
}
