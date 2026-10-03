import type { ServiceConfig, OwnedChild } from './contracts.js';
import type { ExecutionLeaseStore, ExecutionRecord } from './execution-lease.js';
import type { RecordFiles } from './telemetry-store.js';

export interface TunnelRegistration {
  schemaVersion: 1; role: 'tunnel'; configDigest: string;
  executionRevision: number; executionToken: string; child: OwnedChild;
}
export function encodeTunnelRegistration(_value: unknown): Buffer { throw new Error('NOT_IMPLEMENTED'); }
export function decodeTunnelRegistration(_bytes: Buffer): TunnelRegistration { throw new Error('NOT_IMPLEMENTED'); }
export function matchesTunnelExecution(_record: TunnelRegistration, _execution: ExecutionRecord): boolean { return false; }
export class TunnelRegistrationStore {
  constructor(_files: RecordFiles, _execution: Pick<ExecutionLeaseStore, 'read'>) {}
  async read(): Promise<TunnelRegistration | null> { throw new Error('NOT_IMPLEMENTED'); }
  async publish(_config: ServiceConfig, _child: OwnedChild): Promise<TunnelRegistration> { throw new Error('NOT_IMPLEMENTED'); }
}
