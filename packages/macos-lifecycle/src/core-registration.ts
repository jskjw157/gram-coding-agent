import { createHash } from 'node:crypto';
import type { OwnedChild, ServiceConfig } from './contracts.js';
import { configDigest, parseConfig } from './config.js';
import { copyCoreChild } from './health-probe.js';
import { decodeExecution, encodeExecution, type ExecutionLeaseStore, type ExecutionRecord } from './execution-lease.js';
import type { RecordFiles } from './telemetry-store.js';

/** Private discovery hint, never authentication or process liveness. */
export interface CoreRegistration {
  schemaVersion: 1; role: 'core'; configDigest: string;
  executionRevision: number; executionToken: string; child: OwnedChild;
}
const keys = ['schemaVersion', 'role', 'configDigest', 'executionRevision', 'executionToken', 'child'];
const codes = new Set(['INVALID_CORE_REGISTRATION', 'STATE_IO', 'STATE_CONFLICT', 'UNSAFE_PATH', 'BUSY']);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function invalid(): never { throw new Error('INVALID_CORE_REGISTRATION'); }
function safe(error: unknown): never {
  const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
  throw new Error(typeof message === 'string' && codes.has(message) ? message : 'STATE_IO');
}
/** libproc start identity, not a PID-only or newly captured observer identity. */
export function coreStartIdentity(value: string): { sec: string; usec: string } {
  const match = /^(0|[1-9][0-9]{0,19})\.(0|[1-9][0-9]{0,5})$/u.exec(value);
  if (!match || !match[1] || !match[2] || BigInt(match[1]) > 0xffff_ffff_ffff_ffffn || BigInt(match[2]) > 999999n) invalid();
  return { sec: match[1], usec: match[2] };
}
function parse(value: unknown): CoreRegistration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const v: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) invalid(); v[key] = d.value;
  }
  if (v.schemaVersion !== 1 || v.role !== 'core' || typeof v.configDigest !== 'string'
    || v.configDigest.length !== 64 || /[^a-f0-9]/u.test(v.configDigest)
    || typeof v.executionRevision !== 'number' || !Number.isSafeInteger(v.executionRevision)
    || v.executionRevision < 1 || v.executionRevision % 2 !== 1
    || typeof v.executionToken !== 'string' || v.executionToken.length !== 36
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v.executionToken)) invalid();
  const child = copyCoreChild(v.child as OwnedChild); coreStartIdentity(child.startIdentity);
  return Object.freeze({ schemaVersion: 1, role: 'core', configDigest: v.configDigest,
    executionRevision: v.executionRevision, executionToken: v.executionToken, child });
}
export function encodeCoreRegistration(value: unknown): Buffer {
  try { return Buffer.from(JSON.stringify(parse(value)) + '\n', 'utf8'); } catch { return invalid(); }
}
export function decodeCoreRegistration(bytes: Buffer): CoreRegistration {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) invalid();
    const copy = Buffer.from(bytes); const record = parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy)));
    if (!encodeCoreRegistration(record).equals(copy)) invalid(); return record;
  } catch { return invalid(); }
}
/** A read-only observer must still prove the current native process/socket. */
export function matchesCoreExecution(record: CoreRegistration, execution: ExecutionRecord): boolean {
  return execution.role === 'core' && execution.state === 'HELD' && execution.revision === record.executionRevision
    && execution.token === record.executionToken && execution.configDigest === record.configDigest
    && execution.releaseDigest === record.child.releaseDigest && execution.generation === record.child.generation;
}
export class CoreRegistrationStore {
  constructor(private readonly files: RecordFiles, private readonly execution: Pick<ExecutionLeaseStore, 'read'>) {}
  private async snapshot(): Promise<{ bytes: Buffer; record: CoreRegistration } | null> {
    const group = await this.files.read('core');
    if (!Array.isArray(group) || Object.getPrototypeOf(group) !== Array.prototype
      || group.length !== 1 || Reflect.ownKeys(group).length !== 2) invalid();
    const d = Object.getOwnPropertyDescriptor(group, '0'); if (!d || !d.enumerable || !('value' in d)) invalid();
    if (d.value === null) return null;
    if (!Buffer.isBuffer(d.value)) invalid(); const bytes = Buffer.from(d.value);
    return { bytes, record: decodeCoreRegistration(bytes) };
  }
  async read(): Promise<CoreRegistration | null> {
    try { return (await this.snapshot())?.record ?? null; } catch (error) { return safe(error); }
  }
  async publish(input: ServiceConfig, inputChild: OwnedChild): Promise<CoreRegistration> {
    try {
      const config = parseConfig(input); const child = copyCoreChild(inputChild); coreStartIdentity(child.startIdentity);
      const digest = configDigest(config);
      const held = decodeExecution(encodeExecution(await this.execution.read('core')));
      const record = parse({ schemaVersion: 1, role: 'core', configDigest: digest,
        executionRevision: held.revision, executionToken: held.token, child });
      if (child.releaseDigest !== config.releaseDigest || !matchesCoreExecution(record, held)) invalid();
      const previous = await this.snapshot(); const bytes = encodeCoreRegistration(record);
      const unchanged = async () => {
        if (!encodeExecution(held).equals(encodeExecution(await this.execution.read('core')))) throw new Error('STATE_CONFLICT');
      };
      await unchanged();
      if (previous?.bytes.equals(bytes)) { await unchanged(); return record; }
      if (previous && previous.record.executionRevision >= held.revision) invalid();
      await this.files.compareAndSwap('core', [previous ? sha(previous.bytes) : null], 0, bytes);
      // Cross-file publication is not atomic. A changed lease makes this hint
      // unusable; preserve it for diagnosis rather than resetting either file.
      await unchanged(); return record;
    } catch (error) { return safe(error); }
  }
}
