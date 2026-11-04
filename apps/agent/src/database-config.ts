import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isIP } from 'node:net';
import { posix } from 'node:path';

export interface DatabaseConnectionConfig {
  readonly id: string;
  readonly engine: 'mysql' | 'mariadb';
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly passwordSecret: string;
  readonly tls: false | { readonly ca?: string };
  readonly maxRows: number;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}
export interface ReadonlyDatabaseConfig {
  readonly version: 1;
  readonly connections: readonly DatabaseConnectionConfig[];
}

const deny = () => new Error('Database configuration denied');

function shape(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw deny();
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > maximum || /[\p{Cc}]/u.test(value)) throw deny();
  return value;
}

function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) throw deny();
  return value;
}

function tls(value: unknown): DatabaseConnectionConfig['tls'] {
  if (value === undefined) return Object.freeze({});
  if (value === false) return false;
  shape(value, [], ['ca']);
  if (value.ca === undefined) return Object.freeze({});
  if (typeof value.ca !== 'string' || Buffer.byteLength(value.ca, 'utf8') > 32768) throw deny();
  const begin = value.ca.indexOf('-----BEGIN CERTIFICATE-----');
  const end = value.ca.indexOf('-----END CERTIFICATE-----');
  if (begin < 0 || end <= begin) throw deny();
  return Object.freeze({ ca: value.ca });
}

function parse(input: unknown): ReadonlyDatabaseConfig {
  shape(input, ['version', 'connections']);
  if (input.version !== 1 || !Array.isArray(input.connections) || input.connections.length < 1 || input.connections.length > 8) throw deny();
  const ids = new Set<string>();
  const connections = input.connections.map((value: unknown): DatabaseConnectionConfig => {
    shape(value, ['id', 'engine', 'host', 'database', 'user', 'passwordSecret'], ['port', 'tls', 'maxRows', 'timeoutMs', 'maxBytes']);
    if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value.id) || ids.has(value.id)) throw deny();
    ids.add(value.id);
    if (value.engine !== 'mysql' && value.engine !== 'mariadb') throw deny();
    if (typeof value.host !== 'string' || !value.host.length || value.host.length > 253 ||
        /[\\/@?#\s\p{Cc}\p{Cf}]/u.test(value.host) || (value.host.includes(':') && isIP(value.host) !== 6)) throw deny();
    if (typeof value.passwordSecret !== 'string' || !/^database-readonly-[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u.test(value.passwordSecret)) throw deny();
    return Object.freeze({ id: value.id, engine: value.engine, host: value.host,
      port: integer(value.port, 3306, 1, 65535), database: text(value.database, 256), user: text(value.user, 256),
      passwordSecret: value.passwordSecret, tls: tls(value.tls), maxRows: integer(value.maxRows, 500, 1, 5000),
      timeoutMs: integer(value.timeoutMs, 10000, 1000, 30000), maxBytes: integer(value.maxBytes, 1048576, 1024, 4194304) });
  });
  return Object.freeze({ version: 1, connections: Object.freeze(connections) });
}

export function loadDatabaseConfig(path: string): ReadonlyDatabaseConfig {
  try {
    if (process.platform !== 'linux' || typeof path !== 'string' || path.length > 4096 || !posix.isAbsolute(path) ||
        posix.normalize(path) !== path || /[\\\p{Cc}\p{Cf}]/u.test(path) || realpathSync(path) !== path) throw deny();
    for (let parent = posix.dirname(path);; parent = posix.dirname(parent)) {
      const st = lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0 || realpathSync(parent) !== parent) throw deny();
      if (parent === '/') break;
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || (before.mode & 0o022n) !== 0n || before.size > 65536n) throw deny();
      const bytes = readFileSync(fd);const after = fstatSync(fd, { bigint: true });
      if (bytes.length > 65536 || BigInt(bytes.length) !== before.size ||
          (['dev', 'ino', 'size', 'uid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'] as const).some(key => before[key] !== after[key])) throw deny();
      return parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } finally { closeSync(fd); }
  } catch { throw deny(); }
}
