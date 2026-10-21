import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { Role } from './contracts.js';
import type { RecordFiles } from './telemetry-store.js';

/** Nonsecret cooperative occupancy, not authentication or process liveness.
 * No expiry, PID stealing, implicit initialization or recovery/reset API. */
export interface ExecutionRecord {
  schemaVersion: 1; role: Role; revision: number; state: 'FREE' | 'HELD';
  token: string | null; generation: string | null; configDigest: string | null; releaseDigest: string | null;
}
export interface ExecutionLease { readonly role: Role; readonly generation: string }
const keys = ['schemaVersion', 'role', 'revision', 'state', 'token', 'generation', 'configDigest', 'releaseDigest'];
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const codes = new Set(['INVALID_EXECUTION', 'MISSING_EXECUTION', 'STATE_IO', 'STATE_CONFLICT', 'UNSAFE_PATH', 'BUSY']);
function invalid(): never { throw new Error('INVALID_EXECUTION'); }
function safe(error: unknown): never {
  const value = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
  throw new Error(typeof value === 'string' && codes.has(value) ? value : 'STATE_IO');
}
function roleOnly(value: unknown): asserts value is Role { if (value !== 'core' && value !== 'tunnel') invalid(); }
function generation(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && /^[A-Za-z0-9]/u.test(value) && !/[^A-Za-z0-9._-]/u.test(value);
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/u.test(value);
}
function parse(value: unknown): ExecutionRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) invalid();
  const v: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) invalid(); v[key] = d.value;
  }
  roleOnly(v.role);
  if (v.schemaVersion !== 1 || typeof v.revision !== 'number' || !Number.isSafeInteger(v.revision)
    || v.revision < 0 || (v.state !== 'FREE' && v.state !== 'HELD')) invalid();
  const initial = v.revision === 0;
  if (initial) {
    if (v.state !== 'FREE' || [v.token, v.generation, v.configDigest, v.releaseDigest].some(x => x !== null)) invalid();
  } else {
    if (typeof v.token !== 'string' || v.token.length !== 36
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v.token)
      || !generation(v.generation) || !digest(v.configDigest) || !digest(v.releaseDigest)
      || (v.state === 'HELD') !== (v.revision % 2 === 1)) invalid();
  }
  return { schemaVersion: 1, role: v.role, revision: v.revision, state: v.state,
    token: v.token as string | null, generation: v.generation as string | null,
    configDigest: v.configDigest as string | null, releaseDigest: v.releaseDigest as string | null };
}
export function encodeExecution(value: unknown): Buffer {
  try { return Buffer.from(JSON.stringify(parse(value)) + '\n', 'utf8'); } catch { return invalid(); }
}
export function decodeExecution(bytes: Buffer): ExecutionRecord {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) invalid();
    const copy = Buffer.from(bytes);
    const value = parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy)));
    if (!encodeExecution(value).equals(copy)) invalid(); return value;
  } catch { return invalid(); }
}
interface Held { record: ExecutionRecord; digest: string; releasing: Promise<void> | null }
/** Internal local capability. Only an independently validated new installation
 * may call initializeNew. An abandoned HELD slot needs later stopped recovery,
 * not deletion, elapsed time or a new object's claim that it is safe. */
export class ExecutionLeaseStore {
  private readonly held = new WeakMap<ExecutionLease, Held>();
  constructor(private readonly files: RecordFiles) {}
  async initializeNew(role: Role): Promise<void> {
    try {
      roleOnly(role);
      const bytes = encodeExecution({ schemaVersion: 1, role, revision: 0, state: 'FREE', token: null,
        generation: null, configDigest: null, releaseDigest: null });
      await this.files.compareAndSwap(role, [null], 0, bytes);
    } catch (error) { safe(error); }
  }
  private async snapshot(role: Role): Promise<{ record: ExecutionRecord; digest: string }> {
    roleOnly(role); const group = await this.files.read(role);
    if (!Array.isArray(group) || Object.getPrototypeOf(group) !== Array.prototype
      || group.length !== 1 || Reflect.ownKeys(group).length !== 2) invalid();
    const d = Object.getOwnPropertyDescriptor(group, '0');
    if (!d || !d.enumerable || !('value' in d)) invalid();
    if (d.value === null) throw new Error('MISSING_EXECUTION');
    if (!Buffer.isBuffer(d.value)) invalid();
    const bytes = Buffer.from(d.value); const record = decodeExecution(bytes);
    if (record.role !== role) invalid(); return { record, digest: sha(bytes) };
  }
  async read(role: Role): Promise<ExecutionRecord> {
    try { return Object.freeze((await this.snapshot(role)).record); } catch (error) { return safe(error); }
  }
  async acquire(role: Role, nextGeneration: string, configDigest: string, releaseDigest: string): Promise<ExecutionLease> {
    try {
      roleOnly(role);
      if (!generation(nextGeneration) || !digest(configDigest) || !digest(releaseDigest)) invalid();
      const previous = await this.snapshot(role);
      if (previous.record.state !== 'FREE') throw new Error('BUSY');
      if (previous.record.generation === nextGeneration || previous.record.revision >= Number.MAX_SAFE_INTEGER - 1) invalid();
      const record: ExecutionRecord = { schemaVersion: 1, role, revision: previous.record.revision + 1,
        state: 'HELD', token: randomUUID(), generation: nextGeneration, configDigest, releaseDigest };
      const bytes = encodeExecution(record);
      await this.files.compareAndSwap(role, [previous.digest], 0, bytes);
      const lease = Object.freeze({ role, generation: nextGeneration });
      this.held.set(lease, { record, digest: sha(bytes), releasing: null }); return lease;
    } catch (error) { return safe(error); }
  }
  async recoverStopped(role: Role,
    verify: (record: Readonly<ExecutionRecord>) => Promise<boolean>): Promise<void> {
    try {
      roleOnly(role);
      if (typeof verify !== 'function') invalid();
      const previous = await this.snapshot(role);
      if (previous.record.state !== 'HELD') throw new Error('BUSY');
      const candidate = Object.freeze({ ...previous.record });
      if ((await verify(candidate)) !== true) throw new Error('BUSY');
      await this.files.compareAndSwap(role, [previous.digest], 0,
        encodeExecution({ ...previous.record, revision: previous.record.revision + 1, state: 'FREE' }));
    } catch (error) { safe(error); }
  }
  async release(lease: ExecutionLease): Promise<void> {
    try {
      const held = this.held.get(lease); if (!held) invalid();
      if (held.releasing === null) {
        held.releasing = this.files.compareAndSwap(held.record.role, [held.digest], 0,
          encodeExecution({ ...held.record, revision: held.record.revision + 1, state: 'FREE' }));
      }
      // A successful repeated release is a no-op, even after a newer owner.
      // An uncertain failure is never retried against newly read state.
      await held.releasing;
    } catch (error) { safe(error); }
  }
}
