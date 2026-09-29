import type { OwnedChild, ServiceConfig } from './contracts.js';
import type { ExecutionLeaseStore } from './execution-lease.js';
import type { RecordFiles } from './telemetry-store.js';

/** Private discovery hint, never authentication or process liveness. */
export interface CoreRegistration {
  schemaVersion: 1; role: 'core'; configDigest: string;
  executionRevision: number; executionToken: string; child: OwnedChild;
}
export function encodeCoreRegistration(_value: unknown): Buffer { throw new Error('NOT_IMPLEMENTED'); }
export function decodeCoreRegistration(_bytes: Buffer): CoreRegistration { throw new Error('NOT_IMPLEMENTED'); }
export class CoreRegistrationStore {
  constructor(private readonly files: RecordFiles, private readonly execution: Pick<ExecutionLeaseStore, 'read'>) {}
  async read(): Promise<CoreRegistration | null> { throw new Error('NOT_IMPLEMENTED'); }
  async publish(_config: ServiceConfig, _child: OwnedChild): Promise<CoreRegistration> { throw new Error('NOT_IMPLEMENTED'); }
}
