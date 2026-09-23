import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { Role } from './contracts.js';
import { beginAttempt, freshHistory, parseHistory, recordExit, recoverAttempt, resetFailure, type CircuitHistory } from './circuit.js';

/** Internal durable port. A successful CAS means file AND directory durability
 * completed. Unknown commit outcomes throw; callers reload, never retry an old
 * state blindly. Native path/owner/ACL trust is supplied by the file adapter.
 */
export interface CircuitFiles {
  read(role: Role): Promise<Buffer | null>;
  compareAndSwap(role: Role, expectedDigest: string | null, bytes: Buffer): Promise<void>;
}
export interface HistorySnapshot { role: Role; digest: string; history: CircuitHistory }
export type CircuitMutation =
  | { kind: 'begin'; generation: string; nowMs: number }
  | { kind: 'exit'; generation: string; nowMs: number; intentional: boolean }
  | { kind: 'recover'; nowMs: number }
  | { kind: 'reset'; generation: string; nowMs: number };
const MAX_BYTES = 65536;
const codes = new Set(['INVALID_HISTORY', 'MISSING_HISTORY', 'RESTART_BUDGET', 'ACTIVE_ATTEMPT',
  'STATE_CONFLICT', 'STATE_IO', 'UNSAFE_PATH', 'BUSY']);
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
function invalid(): never { throw new Error('INVALID_HISTORY'); }
function safe(error: unknown): never {
  const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
  throw new Error(typeof message === 'string' && codes.has(message) ? message : 'STATE_IO');
}
function roleOnly(value: unknown): asserts value is Role {
  if (value !== 'core' && value !== 'tunnel') invalid();
}
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) invalid();
    result[key] = d.value;
  }
  return result;
}
export function encodeHistory(history: CircuitHistory): Buffer {
  try {
    const bytes = Buffer.from(JSON.stringify(parseHistory(history)) + '\n', 'utf8');
    if (bytes.length > MAX_BYTES) invalid();
    return bytes;
  } catch { return invalid(); }
}
export function decodeHistory(bytes: Buffer): CircuitHistory {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) invalid();
    const copy = Buffer.from(bytes);
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy));
    const result = parseHistory(value);
    // Canonical comparison also refuses duplicate keys, BOM and hidden fields.
    if (!encodeHistory(result).equals(copy)) invalid();
    return result;
  } catch { return invalid(); }
}
function snapshot(role: Role, bytes: Buffer): HistorySnapshot {
  return { role, digest: sha(bytes), history: decodeHistory(bytes) };
}
function transition(history: CircuitHistory, value: CircuitMutation): CircuitHistory {
  const kind = value !== null && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, 'kind') : undefined;
  if (!kind || !('value' in kind)) invalid();
  const fieldSets: Record<string, readonly string[]> = {
    begin: ['kind', 'generation', 'nowMs'], exit: ['kind', 'generation', 'nowMs', 'intentional'],
    recover: ['kind', 'nowMs'], reset: ['kind', 'generation', 'nowMs'],
  };
  if (typeof kind.value !== 'string' || !Object.hasOwn(fieldSets, kind.value)) invalid();
  const fields = fieldSets[kind.value]; if (!fields) invalid();
  const m = data(value, fields);
  if (typeof m.nowMs !== 'number') invalid();
  if (m.kind === 'recover') return recoverAttempt(history, m.nowMs);
  if (typeof m.generation !== 'string') invalid();
  if (m.kind === 'begin') return beginAttempt(history, m.generation, m.nowMs);
  if (m.kind === 'reset') return resetFailure(history, m.generation, m.nowMs);
  if (m.kind !== 'exit' || typeof m.intentional !== 'boolean'
    || history.activeAttempt === null || history.activeAttempt.generation !== m.generation) invalid();
  return recordExit(history, m.nowMs, m.intentional);
}

/** Internal state service, not an authorization API. initializeNew is only for a
 * separately verified new installation; reset requires stopped/local approval.
 * Neither operation is exposed through a CLI, MCP or running supervisor here.
 */
export class LifecycleStore {
  constructor(private readonly files: CircuitFiles) {}
  async read(role: Role): Promise<HistorySnapshot> {
    try {
      roleOnly(role);
      const bytes = await this.files.read(role);
      if (bytes === null) throw new Error('MISSING_HISTORY');
      if (!Buffer.isBuffer(bytes)) invalid();
      return snapshot(role, Buffer.from(bytes));
    } catch (error) { return safe(error); }
  }
  async initializeNew(role: Role, nowMs: number): Promise<HistorySnapshot> {
    try {
      roleOnly(role);
      const bytes = encodeHistory(freshHistory(nowMs));
      await this.files.compareAndSwap(role, null, Buffer.from(bytes));
      return snapshot(role, bytes);
    } catch (error) { return safe(error); }
  }
  async write(role: Role, current: HistorySnapshot, mutation: CircuitMutation): Promise<HistorySnapshot> {
    try {
      roleOnly(role);
      const s = data(current, ['role', 'digest', 'history']);
      if (s.role !== role || typeof s.digest !== 'string' || s.digest.length !== 64 || /[^a-f0-9]/u.test(s.digest)) invalid();
      const history = parseHistory(s.history);
      if (sha(encodeHistory(history)) !== s.digest) invalid();
      const bytes = encodeHistory(transition(history, mutation));
      await this.files.compareAndSwap(role, s.digest, Buffer.from(bytes));
      return snapshot(role, bytes);
    } catch (error) { return safe(error); }
  }
}
