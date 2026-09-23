import type { Socket } from 'node:net';
import type { OwnedChild } from '../contracts.js';
import type { ConnectedPeerVerifier } from './loopback-http.js';

export interface LiveProcessHandle {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  killed: boolean;
}
export interface ExecutableIdentity { dev: bigint; ino: bigint }
export type PeerVerdict = 'OWNED' | 'FOREIGN' | 'UNKNOWN';
export interface NativeProcessIdentity {
  pid: number; uid: number; startSec: string; startUsec: string;
  executable: ExecutableIdentity;
}
export interface NativePeerProofPort {
  capture(request: Omit<NativeProcessIdentity, 'startSec' | 'startUsec'>, signal: AbortSignal):
    Promise<{ sec: string; usec: string } | null>;
  current(request: NativeProcessIdentity, signal: AbortSignal): Promise<PeerVerdict>;
  peer(request: NativeProcessIdentity & { serverPort: number; clientPort: number }, signal: AbortSignal): Promise<PeerVerdict>;
}
export interface MacProcessSeal {
  child: Readonly<OwnedChild>;
  handle: LiveProcessHandle;
  identity: Readonly<NativeProcessIdentity>;
}
export interface SealInput {
  role: 'core'; uid: number; generation: string; releaseDigest: string; executable: ExecutableIdentity;
}

export async function sealMacOwnedChild(_handle: LiveProcessHandle, _input: SealInput, _proof: NativePeerProofPort,
  _signal: AbortSignal): Promise<MacProcessSeal | null> {
  throw new Error('NOT_IMPLEMENTED');
}
export function createMacConnectedPeerVerifier(_seal: MacProcessSeal, _proof: NativePeerProofPort): ConnectedPeerVerifier {
  throw new Error('NOT_IMPLEMENTED');
}
void (null as Socket | null);
