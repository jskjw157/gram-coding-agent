import { createHash } from 'node:crypto';
import type { Role } from './contracts.js';
import { currentStatus, decodeStatus, encodeStatus, parseEvent, parseStatus, type ServiceStatus, type StatusIdentity } from './telemetry.js';
import { LOG_MAX_BYTES, planEventAppend } from './event-log.js';

/** Internal fixed-layout byte port. Exactly one status slot or three event
 * slots; CAS covers the whole group, not only the one slot being replaced.
 */
export interface RecordFiles {
  read(role: Role): Promise<readonly (Buffer | null)[]>;
  compareAndSwap(role: Role, expectedDigests: readonly (string | null)[], slot: number, bytes: Buffer): Promise<void>;
}
const digest = (b: Buffer | null): string | null => b === null ? null : createHash('sha256').update(b).digest('hex');
function invalid(): never { throw new Error('INVALID_TELEMETRY'); }
function slots(value: readonly (Buffer | null)[], size: number): (Buffer | null)[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length !== size || Reflect.ownKeys(value).length !== size + 1) invalid();
  const result: (Buffer | null)[] = [];
  for (let i = 0; i < size; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !('value' in d)
      || !(d.value === null || (Buffer.isBuffer(d.value) && d.value.length <= (size === 1 ? 65536 : LOG_MAX_BYTES)))) invalid();
    result.push(d.value === null ? null : Buffer.from(d.value));
  }
  return result;
}
function safe(error: unknown): never {
  const value = error instanceof Error ? Object.getOwnPropertyDescriptor(error, 'message')?.value : undefined;
  const allowed = ['INVALID_TELEMETRY', 'STATE_CONFLICT', 'UNSAFE_PATH', 'BUSY', 'STATE_IO'];
  throw new Error(typeof value === 'string' && allowed.includes(value) ? value : 'STATE_IO');
}

/** No automatic retry, circuit reset or process action. The owner is a trusted
 * local supervisor context, not a caller-provided authorization claim. Status
 * alone never proves liveness, health, business readiness or permission.
 */
export class TelemetryStore {
  constructor(private readonly statusFiles: RecordFiles, private readonly eventFiles: RecordFiles) {}
  async readStatus(role: Role, owner: StatusIdentity, nowMs: number): Promise<ServiceStatus | null> {
    try {
      if (role !== 'core' && role !== 'tunnel') invalid();
      const [bytes] = slots(await this.statusFiles.read(role), 1);
      if (!bytes) return null;
      try { const value = decodeStatus(bytes); return value.role === role ? currentStatus(value, owner, nowMs) : null; }
      catch { return null; }
    } catch (error) { return safe(error); }
  }
  async writeStatus(role: Role, value: unknown, owner: StatusIdentity): Promise<void> {
    try {
      const status = parseStatus(value);
      if (status.role !== role || currentStatus(status, owner, status.observedAtMs) === null) invalid();
      const bytes = encodeStatus(status);
      const previous = slots(await this.statusFiles.read(role), 1);
      const [old] = previous;
      if (old !== null && old !== undefined) {
        const saved = decodeStatus(old); if (saved.role !== role) invalid();
        // A wall-clock millisecond is not a unique observation sequence.
        // Sequential same-tick transitions are allowed; CAS still fences races.
        if (status.observedAtMs < saved.observedAtMs || (status.generation === saved.generation
          && status.releaseDigest !== saved.releaseDigest)) throw new Error('STATE_CONFLICT');
      }
      await this.statusFiles.compareAndSwap(role, previous.map(digest), 0, bytes);
    } catch (error) { safe(error); }
  }
  async appendEvent(role: Role, value: unknown): Promise<void> {
    try {
      const event = parseEvent(value); if (event.role !== role) invalid();
      const previous = slots(await this.eventFiles.read(role), 3);
      const next = planEventAppend(previous, role, event);
      await this.eventFiles.compareAndSwap(role, previous.map(digest), next.slot, next.bytes);
    } catch (error) { safe(error); }
  }
}
