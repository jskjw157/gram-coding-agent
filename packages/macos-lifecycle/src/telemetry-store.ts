import type { Role } from './contracts.js';
import type { ServiceStatus, StatusIdentity } from './telemetry.js';
export interface RecordFiles {
  read(role: Role): Promise<readonly (Buffer | null)[]>;
  compareAndSwap(role: Role, expectedDigests: readonly (string | null)[], slot: number, bytes: Buffer): Promise<void>;
}
export class TelemetryStore {
  constructor(private readonly statusFiles: RecordFiles, private readonly eventFiles: RecordFiles) {}
  async readStatus(role: Role, owner: StatusIdentity, nowMs: number): Promise<ServiceStatus | null> {
    void role; void owner; void nowMs; void this.statusFiles; throw new Error('NOT_IMPLEMENTED');
  }
  async writeStatus(role: Role, value: unknown, owner: StatusIdentity): Promise<void> {
    void role; void value; void owner; throw new Error('NOT_IMPLEMENTED');
  }
  async appendEvent(role: Role, value: unknown): Promise<void> {
    void role; void value; void this.eventFiles; throw new Error('NOT_IMPLEMENTED');
  }
}
