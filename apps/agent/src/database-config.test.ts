import { chmodSync, constants, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDatabaseConfig } from './database-config.js';

// Real fixture bytes and descriptors, synthetic installed ownership: this tests
// loader decisions, not actual root provisioning or operating-system isolation.
const fixture = vi.hoisted(() => ({ path: '', descriptors: new Set<number>(), fileUid: 0n, ancestorUid: 0,
  ancestorWritable: false, reads: 0, closes: 0, flags: 0, afterRead: undefined as (() => void) | undefined }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs,
    openSync(...args: Parameters<typeof fs.openSync>) {
      const fd = fs.openSync(...args);
      if (args[0] === fixture.path) { fixture.descriptors.add(fd);fixture.flags = Number(args[1]); }
      return fd;
    },
    fstatSync(fd: number, options?: { bigint?: boolean }) {
      const st = fs.fstatSync(fd, options as { bigint: true });
      if (fixture.descriptors.has(fd)) Object.assign(st, { uid: fixture.fileUid });
      return st;
    },
    lstatSync(path: string) {
      const st = fs.lstatSync(path);
      if (fixture.path.startsWith(path === '/' ? '/' : path + '/')) {
        Object.assign(st, { uid: fixture.ancestorUid, mode: (st.mode & ~0o022) | (fixture.ancestorWritable ? 0o020 : 0) });
      }
      return st;
    },
    readFileSync(...args: Parameters<typeof fs.readFileSync>) {
      const bytes = fs.readFileSync(...args);
      if (typeof args[0] === 'number' && fixture.descriptors.has(args[0])) { fixture.reads++;fixture.afterRead?.(); }
      return bytes;
    },
    closeSync(fd: number) {
      if (fixture.descriptors.delete(fd)) fixture.closes++;
      return fs.closeSync(fd);
    },
  };
});

const temporary: string[] = [];
function connection() { return { id: 'reporting', engine: 'mysql', host: 'db.example.test', database: 'reports',
  user: 'reader', passwordSecret: 'database-readonly-reporting' }; }
function config() { return { version: 1, connections: [connection()] }; }
function file(value: unknown = config()) {
  const dir = mkdtempSync(join(tmpdir(), 'gram-database-config-'));temporary.push(dir);
  fixture.path = join(dir, 'database.json');
  writeFileSync(fixture.path, JSON.stringify(value), { mode: 0o600 });
  return fixture.path;
}
function denied(value: unknown) { expect(() => loadDatabaseConfig(file(value))).toThrow(/^Database configuration denied$/u); }
const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';

afterEach(() => {
  expect(fixture.descriptors.size).toBe(0);
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
  fixture.path = '';fixture.fileUid = 0n;fixture.ancestorUid = 0;fixture.ancestorWritable = false;
  fixture.reads = 0;fixture.closes = 0;fixture.flags = 0;fixture.afterRead = undefined;
});

describe('trusted read-only database configuration', () => {
  it('normalizes secure defaults and returns a deeply frozen configuration', () => {
    const result = loadDatabaseConfig(file());
    expect(result).toEqual({ version: 1, connections: [{ ...connection(), port: 3306, tls: {},
      maxRows: 500, timeoutMs: 10000, maxBytes: 1048576 }] });
    expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.connections)).toBe(true);
    expect(Object.isFrozen(result.connections[0])).toBe(true);expect(Object.isFrozen(result.connections[0]?.tls)).toBe(true);
    expect(fixture.closes).toBe(1);
    expect(fixture.flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
    expect(fixture.flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
  });

  it('retains explicit trusted endpoints, TLS choices and execution limits', () => {
    const entries = [
      { ...connection(), id: 'mysql-reporting', host: '::1', port: 3307, tls: false, maxRows: 1, timeoutMs: 1000, maxBytes: 1024 },
      { ...connection(), id: 'mariadb-reporting', engine: 'mariadb', host: '2001:db8::1', port: 65535,
        tls: { ca: pem }, maxRows: 5000, timeoutMs: 30000, maxBytes: 4194304 },
    ];
    expect(loadDatabaseConfig(file({ version: 1, connections: entries })).connections).toEqual(entries);
  });

  it('preserves legitimate spaces and Unicode database and login names', () => {
    const input = { ...connection(), database: ' \u62a5\u8868 \u00e9 ', user: ' user name \u00e9 ' };
    const result = loadDatabaseConfig(file({ version: 1, connections: [input] })).connections[0];
    expect(result?.database).toBe(input.database);expect(result?.user).toBe(input.user);
  });

  it('accepts exactly eight unique connections and ASCII identifier length boundaries', () => {
    const connections = Array.from({ length: 8 }, (_, index) => ({ ...connection(), id: 'c' + index }));
    connections[0] = { ...connection(), id: 'A' + 'x'.repeat(63) };
    expect(loadDatabaseConfig(file({ version: 1, connections })).connections).toHaveLength(8);
  });

  it.each([null, {}, [], { version: 2, connections: [connection()] }, { ...config(), password: 'private-marker' },
    { version: 1, connections: [] }, { version: 1, connections: Array(9).fill(connection()) },
    { version: 1, connections: [connection(), connection()] }, { version: 1, connections: [null] }])('rejects malformed roots, unsupported fields, empty/oversized lists and duplicate IDs %#', denied);

  it('rejects all unapproved connection fields and inline credentials', () => {
    for (const field of ['password', 'url', 'connectionString', 'socketPath', 'driver', 'env', 'rejectUnauthorized', 'extra']) {
      denied({ version: 1, connections: [{ ...connection(), [field]: 'private-marker' }] });
    }
    for (const field of ['id', 'engine', 'host', 'database', 'user', 'passwordSecret']) {
      const entry = Object.fromEntries(Object.entries(connection()).filter(([key]) => key !== field));
      denied({ version: 1, connections: [entry] });
    }
  });

  it('restricts engine, identifier and credential namespace without accepting Agent credentials', () => {
    for (const id of ['', '_hidden', '../private', 'a'.repeat(65)]) denied({ version: 1, connections: [{ ...connection(), id }] });
    for (const engine of ['postgres', 'MySQL', '', null]) denied({ version: 1, connections: [{ ...connection(), engine }] });
    for (const passwordSecret of ['mcp-internal-secret', 'github-token', 'database-readonly-', 'database-readonly-../secret',
      'database-readonly-' + 'a'.repeat(97)]) denied({ version: 1, connections: [{ ...connection(), passwordSecret }] });
  });

  it('rejects URLs, embedded credentials, path/socket syntax and controls in hosts', () => {
    for (const host of ['', 'x'.repeat(254), 'mysql://db.example.test', 'user:pass@db.example.test', '/run/mysql.sock',
      'db\\pipe', 'db\n.example.test', 'db.example.test:3306', 'db name']) {
      denied({ version: 1, connections: [{ ...connection(), host }] });
    }
  });

  it('bounds database and user names by UTF-8 bytes and rejects control characters', () => {
    for (const field of ['database', 'user']) {
      expect(loadDatabaseConfig(file({ version: 1, connections: [{ ...connection(), [field]: '\u00e9'.repeat(128) }] }))).toBeDefined();
      for (const value of ['', 'x'.repeat(257), '\u00e9'.repeat(129), 'name\0suffix', 'name\nline']) {
        denied({ version: 1, connections: [{ ...connection(), [field]: value }] });
      }
    }
  });

  it('validates each numeric limit without coercion', () => {
    const cases: Record<string, unknown[]> = { port: [0, 65536, 1.5, '3306', null], maxRows: [0, 5001, 1.5, '500'],
      timeoutMs: [999, 30001, 1000.5, null], maxBytes: [1023, 4194305, 1024.5, '1024'] };
    for (const [field, values] of Object.entries(cases)) for (const value of values) {
      denied({ version: 1, connections: [{ ...connection(), [field]: value }] });
    }
  });

  it('accepts inline bounded CA material only and forbids insecure driver options', () => {
    for (const tls of [true, null, [], 'false', { ca: '/etc/ca.pem' }, { ca: pem + 'x'.repeat(32768) },
      { ca: '\u00e9'.repeat(16400) + pem }, { ca: null }, { ca: '-----END CERTIFICATE----------BEGIN CERTIFICATE-----' },
      { rejectUnauthorized: false }, { ca: pem, servername: 'override.invalid' }]) {
      denied({ version: 1, connections: [{ ...connection(), tls }] });
    }
  });
});

describe('installed database config file admission', () => {
  it('rejects relative, noncanonical and symlink paths before trusting file contents', () => {
    const path = file();
    for (const input of ['', '.', 'database.json', join(path, '..', '..') + '/./database.json', 'C:\\database.json']) {
      expect(() => loadDatabaseConfig(input)).toThrow(/^Database configuration denied$/u);
    }
    const target = path + '.target';renameSync(path, target);symlinkSync(target, path);
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    expect(fixture.reads).toBe(0);
  });

  it('rejects non-root files and unsafe ancestor authority', () => {
    const path = file();fixture.fileUid = 1000n;
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    fixture.fileUid = 0n;fixture.ancestorUid = 1000;
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    fixture.ancestorUid = 0;fixture.ancestorWritable = true;
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    expect(fixture.reads).toBe(0);
  });

  it('rejects writable, hardlinked and nonregular config files', () => {
    let path = file();chmodSync(path, 0o620);
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    path = file();linkSync(path, path + '.alias');
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    path = file();rmSync(path);mkdirSync(path);
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    expect(fixture.reads).toBe(0);
  });

  it('accepts an exact 64-KiB regular JSON file', () => {
    const path = file();const json = JSON.stringify(config());
    writeFileSync(path, json + ' '.repeat(65536 - Buffer.byteLength(json, 'utf8')));
    expect(loadDatabaseConfig(path).connections).toHaveLength(1);
    expect(fixture.reads).toBe(1);expect(fixture.closes).toBe(1);
  });

  it('rejects files over 64 KiB before reading and closes the descriptor', () => {
    const path = file();writeFileSync(path, ' '.repeat(65537));
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    expect(fixture.reads).toBe(0);expect(fixture.closes).toBe(1);
  });

  it('rejects malformed UTF-8 and JSON with a fixed error and closes the descriptor', () => {
    const path = file();
    const [prefix, suffix] = JSON.stringify({ ...config(), connections: [{ ...connection(), database: 'UTF8_PLACEHOLDER' }] }).split('UTF8_PLACEHOLDER');
    writeFileSync(path, Buffer.concat([Buffer.from(prefix ?? ''), Buffer.from([0xc3, 0x28]), Buffer.from(suffix ?? '')]));
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    writeFileSync(path, '{private-marker');
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    expect(fixture.closes).toBe(2);
  });

  it('detects actual file changes during the held-descriptor read', () => {
    const path = file();fixture.afterRead = () => writeFileSync(path, '{}');
    expect(() => loadDatabaseConfig(path)).toThrow(/^Database configuration denied$/u);
    expect(fixture.closes).toBe(1);
  });
});
