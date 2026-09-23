import type { OwnedChild, SafeCode } from './contracts.js';
export const CORE_PROTOCOL = '2025-11-25';
export type CoreRequest = 'health' | 'initialize' | 'initialized' | 'tools' | 'call';
export interface WireReply { status: number; contentType: string; body: Buffer; sessionId?: string }
export interface CoreCredentials { withValue<T>(use: (secret: string) => Promise<T>): Promise<T> }
export interface OwnedConnection {
  isCurrent(): Promise<boolean>;
  request(kind: CoreRequest, credentials: CoreCredentials, session: string | undefined, signal: AbortSignal): Promise<WireReply>;
  close(): void;
}
export interface CoreConnections {
  openOwnedConnection(child: OwnedChild, port: 3847, signal: AbortSignal): Promise<OwnedConnection | null>;
}
export interface CoreEvidence {
  state: 'LOCAL_CORE_HEALTHY' | 'UNKNOWN' | 'BLOCKED'; code: SafeCode;
  generation: string; releaseDigest: string; observedAtMs: number;
}
export interface ProbeOptions { signal?: AbortSignal; now?: () => number }
export function validCoreHealth(value: unknown): boolean { void value; return false; }
export async function probeCore(child: OwnedChild, connections: CoreConnections, credentials: CoreCredentials,
  options: ProbeOptions = {}): Promise<CoreEvidence> {
  void child; void connections; void credentials; void options; throw new Error('NOT_IMPLEMENTED');
}
