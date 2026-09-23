import type { Socket } from 'node:net';
import type { OwnedChild } from '../contracts.js';
import type { CoreConnections, OwnedConnection } from '../health-probe.js';
export interface ConnectedPeerVerifier {
  current(child: OwnedChild): Promise<boolean>;
  verify(socket: Socket, child: OwnedChild, signal: AbortSignal): Promise<'OWNED' | 'FOREIGN' | 'UNKNOWN'>;
}
export async function bindOwnedConnection(socket: Socket, child: OwnedChild, verifier: ConnectedPeerVerifier | undefined,
  signal: AbortSignal): Promise<OwnedConnection | null> {
  void socket; void child; void verifier; void signal; throw new Error('NOT_IMPLEMENTED');
}
export function createLoopbackConnections(verifier?: ConnectedPeerVerifier): CoreConnections {
  void verifier; throw new Error('NOT_IMPLEMENTED');
}
