import { createHash } from 'node:crypto';
import type { OwnedChild, ServiceConfig } from './contracts.js';
import { configDigest, parseConfig } from './config.js';
import { coreStartIdentity } from './core-registration.js';
import { decodeExecution, encodeExecution, type ExecutionLeaseStore, type ExecutionRecord } from './execution-lease.js';
import { copyCoreChild } from './health-probe.js';
import type { RecordFiles } from './telemetry-store.js';

export interface TunnelRegistration {
  schemaVersion: 1; role: 'tunnel'; configDigest: string;
  executionRevision: number; executionToken: string; child: OwnedChild;
}

const keys = ['schemaVersion', 'role', 'configDigest', 'executionRevision', 'executionToken', 'child'];
const codes = new Set(['INVALID_TUNNEL_REGISTRATION', 'STATE_IO', 'STATE_CONFLICT', 'UNSAFE_PATH', 'BUSY']);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function invalid(): never { throw new Error('INVALID_TUNNEL_REGISTRATION'); }
function safe(error: unknown): never {
  const message = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
  throw new Error(typeof message === 'string' && codes.has(message) ? message : 'STATE_IO');
}
function tunnelChild(value: unknown): OwnedChild {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const role = Object.getOwnPropertyDescriptor(value, 'role');
  if (!role || !('value' in role) || role.value !== 'tunnel') invalid();
  const normalized = copyCoreChild({ ...(value as OwnedChild), role: 'core' });
  coreStartIdentity(normalized.startIdentity);
  return Object.freeze({ ...normalized, role: 'tunnel' as const });
}
function parse(value: unknown): TunnelRegistration {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) invalid();
  const v: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    v[key] = descriptor.value;
  }
  if (v.schemaVersion !== 1 || v.role !== 'tunnel'
    || typeof v.configDigest !== 'string' || v.configDigest.length !== 64 || /[^a-f0-9]/u.test(v.configDigest)
    || typeof v.executionRevision !== 'number' || !Number.isSafeInteger(v.executionRevision)
    || v.executionRevision < 1 || v.executionRevision % 2 !== 1
    || typeof v.executionToken !== 'string' || v.executionToken.length !== 36
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v.executionToken)) invalid();
  return Object.freeze({
    schemaVersion: 1, role: 'tunnel', configDigest: v.configDigest,
    executionRevision: v.executionRevision, executionToken: v.executionToken,
    child: tunnelChild(v.child),
  });
}

export function encodeTunnelRegistration(value: unknown): Buffer {
  try { return Buffer.from(JSON.stringify(parse(value)) + '\n', 'utf8'); }
  catch { return invalid(); }
}
export function decodeTunnelRegistration(bytes: Buffer): TunnelRegistration {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 65536) invalid();
    const copy = Buffer.from(bytes);
    const record = parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(copy)));
    if (!encodeTunnelRegistration(record).equals(copy)) invalid();
    return record;
  } catch { return invalid(); }
}
export function matchesTunnelExecution(record: TunnelRegistration, execution: ExecutionRecord): boolean {
  return execution.role === 'tunnel' && execution.state === 'HELD'
    && execution.revision === record.executionRevision && execution.token === record.executionToken
    && execution.configDigest === record.configDigest && execution.releaseDigest === record.child.releaseDigest
    && execution.generation === record.child.generation;
}

export class TunnelRegistrationStore {
  constructor(private readonly files: RecordFiles,
    private readonly execution: Pick<ExecutionLeaseStore, 'read'>) {}

  private async snapshot(): Promise<{ bytes: Buffer; record: TunnelRegistration } | null> {
    const group = await this.files.read('tunnel');
    if (!Array.isArray(group) || Object.getPrototypeOf(group) !== Array.prototype
      || group.length !== 1 || Reflect.ownKeys(group).length !== 2) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(group, '0');
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    if (descriptor.value === null) return null;
    if (!Buffer.isBuffer(descriptor.value)) invalid();
    const bytes = Buffer.from(descriptor.value);
    return { bytes, record: decodeTunnelRegistration(bytes) };
  }

  async read(): Promise<TunnelRegistration | null> {
    try { return (await this.snapshot())?.record ?? null; }
    catch (error) { return safe(error); }
  }

  async publish(input: ServiceConfig, inputChild: OwnedChild): Promise<TunnelRegistration> {
    try {
      const config = parseConfig(input);
      if (!config.tunnel.enabled) invalid();
      const child = tunnelChild(inputChild);
      const digest = configDigest(config);
      const held = decodeExecution(encodeExecution(await this.execution.read('tunnel')));
      const record = parse({
        schemaVersion: 1, role: 'tunnel', configDigest: digest,
        executionRevision: held.revision, executionToken: held.token, child,
      });
      if (child.releaseDigest !== config.releaseDigest || !matchesTunnelExecution(record, held)) invalid();
      const previous = await this.snapshot();
      const bytes = encodeTunnelRegistration(record);
      const unchanged = async () => {
        if (!encodeExecution(held).equals(encodeExecution(await this.execution.read('tunnel')))) {
          throw new Error('STATE_CONFLICT');
        }
      };
      await unchanged();
      if (previous?.bytes.equals(bytes)) { await unchanged(); return record; }
      if (previous && previous.record.executionRevision >= held.revision) invalid();
      await this.files.compareAndSwap('tunnel', [previous ? sha(previous.bytes) : null], 0, bytes);
      await unchanged();
      return record;
    } catch (error) { return safe(error); }
  }
}
