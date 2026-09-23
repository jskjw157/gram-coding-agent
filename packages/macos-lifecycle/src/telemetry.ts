import type { Role, SafeCode } from './contracts.js';
export interface SafeEvent {
  schemaVersion: 1; role: Role; generation: string; releaseDigest: string;
  code: SafeCode; observedAtMs: number; attemptCount: number;
}
export type ServiceState = 'STOPPED' | 'VALIDATING' | 'STARTING' | 'RUNNING' | 'LOCAL_CORE_HEALTHY'
  | 'BACKOFF' | 'BLOCKED_CONFIGURATION' | 'BLOCKED_RESTART_BUDGET' | 'STOPPING'
  | 'DISABLED' | 'WAITING_CORE' | 'CONNECTING' | 'TRANSPORT_READY' | 'OFFLINE' | 'AUTH_BLOCKED' | 'UNKNOWN';
export interface ServiceStatus extends SafeEvent { state: ServiceState }
export interface StatusIdentity { role: Role; generation: string; releaseDigest: string }
export function parseEvent(value: unknown): SafeEvent { void value; throw new Error('NOT_IMPLEMENTED'); }
export function parseStatus(value: unknown): ServiceStatus { void value; throw new Error('NOT_IMPLEMENTED'); }
export function encodeStatus(value: unknown): Buffer { void value; throw new Error('NOT_IMPLEMENTED'); }
export function decodeStatus(bytes: Buffer): ServiceStatus { void bytes; throw new Error('NOT_IMPLEMENTED'); }
export function encodeEvent(value: unknown): Buffer { void value; throw new Error('NOT_IMPLEMENTED'); }
export function currentStatus(value: unknown, identity: StatusIdentity, nowMs: number): ServiceStatus | null {
  void value; void identity; void nowMs; throw new Error('NOT_IMPLEMENTED');
}
