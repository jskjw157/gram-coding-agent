import type { Role } from './contracts.js';
import type { RecordFiles } from './telemetry-store.js';

export interface ExecutionRecord {
  schemaVersion: 1; role: Role; revision: number; state: 'FREE' | 'HELD';
  token: string | null; generation: string | null; configDigest: string | null; releaseDigest: string | null;
}
export interface ExecutionLease { readonly role: Role; readonly generation: string }
export function encodeExecution(_value: unknown): Buffer { throw new Error('NOT_IMPLEMENTED'); }
export function decodeExecution(_bytes: Buffer): ExecutionRecord { throw new Error('NOT_IMPLEMENTED'); }
export class ExecutionLeaseStore {
  constructor(_files: RecordFiles) {}
  async initializeNew(_role: Role): Promise<void> { throw new Error('NOT_IMPLEMENTED'); }
  async read(_role: Role): Promise<ExecutionRecord> { throw new Error('NOT_IMPLEMENTED'); }
  async acquire(_role: Role, _generation: string, _configDigest: string, _releaseDigest: string): Promise<ExecutionLease> {
    throw new Error('NOT_IMPLEMENTED');
  }
  async release(_lease: ExecutionLease): Promise<void> { throw new Error('NOT_IMPLEMENTED'); }
}
