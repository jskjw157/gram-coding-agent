import type { Role, SafeCode } from './contracts.js';

/** Local supervisor data only. No child message, exception, URL or secret value
 * is accepted. A syntactically valid identifier is not proof of its provenance.
 * Task4/5 must independently establish the current live owner before using a
 * stored observation; these parsers do not authenticate a process or a grant.
 */
export interface SafeEvent {
  schemaVersion: 1; role: Role; generation: string; releaseDigest: string;
  code: SafeCode; observedAtMs: number; attemptCount: number;
}
export type ServiceState = 'STOPPED' | 'VALIDATING' | 'STARTING' | 'RUNNING' | 'LOCAL_CORE_HEALTHY'
  | 'BACKOFF' | 'BLOCKED_CONFIGURATION' | 'BLOCKED_RESTART_BUDGET' | 'STOPPING'
  | 'DISABLED' | 'WAITING_CORE' | 'CONNECTING' | 'TRANSPORT_READY' | 'OFFLINE' | 'AUTH_BLOCKED' | 'UNKNOWN';
export interface ServiceStatus extends SafeEvent { state: ServiceState }
export interface StatusIdentity { role: Role; generation: string; releaseDigest: string }
const codes = {
  OK: true, UNSUPPORTED_HOST: true, INVALID_CONFIG: true, ACCOUNT_INVALID: true,
  UNTRUSTED_RELEASE: true, UNSAFE_PATH: true, FOREIGN_SERVICE: true, PORT_IN_USE: true,
  CONFIG_CHANGED: true, BUSY: true, AUTH_BLOCKED: true, HEALTH_UNKNOWN: true,
  TOOL_SURFACE_MISMATCH: true, RESTART_BUDGET: true, INVALID_HISTORY: true,
  ROLLBACK_BLOCKED_SCHEMA: true, PARTIAL_INSTALL: true, NOT_AUTHORIZED: true,
  TUNNEL_COMPATIBILITY_REQUIRED: true, INTERNAL_ERROR: true,
} satisfies Record<SafeCode, true>;
const common = ['STOPPED', 'VALIDATING', 'STARTING', 'RUNNING', 'BACKOFF', 'BLOCKED_CONFIGURATION',
  'BLOCKED_RESTART_BUDGET', 'STOPPING', 'AUTH_BLOCKED', 'UNKNOWN'];
const states = {
  core: new Set([...common, 'LOCAL_CORE_HEALTHY']),
  tunnel: new Set([...common, 'DISABLED', 'WAITING_CORE', 'CONNECTING', 'TRANSPORT_READY', 'OFFLINE']),
};
const keys = ['schemaVersion', 'role', 'generation', 'releaseDigest', 'code', 'observedAtMs', 'attemptCount'];
function invalid(): never { throw new Error('INVALID_TELEMETRY'); }
function record(value: unknown, required: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== required.length || own.some(k => typeof k !== 'string' || !required.includes(k))) invalid();
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of required) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) invalid();
    copy[key] = d.value;
  }
  return copy;
}
function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function owner(v: Record<string, unknown>): StatusIdentity {
  if ((v.role !== 'core' && v.role !== 'tunnel') || typeof v.generation !== 'string'
    || v.generation.length === 0 || v.generation.length > 128 || !/^[A-Za-z0-9]/u.test(v.generation)
    || /[^A-Za-z0-9._-]/u.test(v.generation) || typeof v.releaseDigest !== 'string'
    || v.releaseDigest.length !== 64 || /[^a-f0-9]/u.test(v.releaseDigest)) invalid();
  return { role: v.role, generation: v.generation, releaseDigest: v.releaseDigest };
}
function event(v: Record<string, unknown>): SafeEvent {
  const identity = owner(v);
  if (v.schemaVersion !== 1 || typeof v.code !== 'string' || !Object.hasOwn(codes, v.code)
    || !time(v.observedAtMs) || !time(v.attemptCount) || v.attemptCount > 5) invalid();
  return { schemaVersion: 1, ...identity, code: v.code as SafeCode,
    observedAtMs: v.observedAtMs, attemptCount: v.attemptCount };
}
export function parseEvent(value: unknown): SafeEvent {
  try { return event(record(value, keys)); } catch { return invalid(); }
}
export function parseStatus(value: unknown): ServiceStatus {
  try {
    const v = record(value, [...keys, 'state']); const base = event(v);
    if (typeof v.state !== 'string' || !states[base.role].has(v.state)
      || ((v.state === 'LOCAL_CORE_HEALTHY' || v.state === 'TRANSPORT_READY') && base.code !== 'OK')
      || (v.state === 'BLOCKED_RESTART_BUDGET' && base.code !== 'RESTART_BUDGET')) invalid();
    return { ...base, state: v.state as ServiceState };
  } catch { return invalid(); }
}
export function encodeStatus(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(parseStatus(value)) + '\n', 'utf8');
}
export function decodeStatus(bytes: Buffer): ServiceStatus {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) invalid();
    const result = parseStatus(JSON.parse(bytes.toString('utf8')));
    if (!encodeStatus(result).equals(bytes)) invalid();
    return result;
  } catch { return invalid(); }
}
export function encodeEvent(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(parseEvent(value)) + '\n', 'utf8');
}
/** A freshness filter, never a substitute for live peer/ownership proof. */
export function currentStatus(value: unknown, identity: StatusIdentity, nowMs: number): ServiceStatus | null {
  try {
    const wanted = owner(record(identity, ['role', 'generation', 'releaseDigest']));
    const found = parseStatus(value);
    if (!time(nowMs) || found.observedAtMs > nowMs || nowMs - found.observedAtMs >= 30000
      || found.role !== wanted.role || found.generation !== wanted.generation
      || found.releaseDigest !== wanted.releaseDigest) return null;
    return found;
  } catch { return null; }
}
