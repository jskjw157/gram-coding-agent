import type { Socket } from 'node:net';
import type { OwnedChild } from '../contracts.js';
import { copyCoreChild } from '../health-probe.js';
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

const DECIMAL = /^(0|[1-9][0-9]*)$/u;
function validUint(value: string): boolean {
  if (!DECIMAL.test(value) || value.length > 20) return false;
  try { const n = BigInt(value); return n >= 0n && n <= 0xffff_ffff_ffff_ffffn; } catch { return false; }
}
function validUsec(value: string): boolean {
  return validUint(value) && BigInt(value) <= 999999n;
}
function live(handle: LiveProcessHandle): handle is LiveProcessHandle & { pid: number } {
  return Number.isSafeInteger(handle.pid) && (handle.pid ?? 0) > 0 && (handle.pid ?? 0) <= 0x7fff_ffff
    && handle.exitCode === null && handle.signalCode === null && handle.killed === false;
}
function validExecutable(value: ExecutableIdentity): boolean {
  return typeof value.dev === 'bigint' && typeof value.ino === 'bigint'
    && value.dev >= 0n && value.ino > 0n
    && value.dev <= 0xffff_ffff_ffff_ffffn && value.ino <= 0xffff_ffff_ffff_ffffn;
}
function sameChild(a: OwnedChild, b: OwnedChild): boolean {
  return a.role === b.role && a.pid === b.pid && a.uid === b.uid && a.startIdentity === b.startIdentity
    && a.generation === b.generation && a.releaseDigest === b.releaseDigest;
}
function tuple(socket: Socket): { serverPort: number; clientPort: number } | null {
  if (socket.localAddress !== '127.0.0.1' || socket.remoteAddress !== '127.0.0.1'
    || !Number.isSafeInteger(socket.localPort) || !Number.isSafeInteger(socket.remotePort)
    || (socket.localPort ?? 0) < 1 || (socket.localPort ?? 0) > 65535
    || (socket.remotePort ?? 0) < 1 || (socket.remotePort ?? 0) > 65535) return null;
  return { serverPort: socket.remotePort as number, clientPort: socket.localPort as number };
}
async function bounded<T>(parent: AbortSignal | undefined, use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), 2000);
  const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
  try {
    if (signal.aborted) throw new Error('ABORTED');
    return await use(signal);
  } finally { clearTimeout(timer); deadline.abort(); }
}

export async function sealMacOwnedChild(handle: LiveProcessHandle, input: SealInput, proof: NativePeerProofPort,
  signal: AbortSignal): Promise<MacProcessSeal | null> {
  try {
    if (!live(handle) || signal.aborted || !validExecutable(input.executable)) return null;
    const pid = handle.pid;
    const request = Object.freeze({ pid, uid: input.uid,
      executable: Object.freeze({ dev: input.executable.dev, ino: input.executable.ino }) });
    const captured = await bounded(signal, s => proof.capture(request, s));
    if (!captured || !validUint(captured.sec) || !validUsec(captured.usec) || !live(handle) || handle.pid !== pid) return null;
    const child = copyCoreChild({ role: input.role, pid, uid: input.uid,
      startIdentity: `${captured.sec}.${captured.usec}`,
      generation: input.generation, releaseDigest: input.releaseDigest });
    const identity = Object.freeze({ pid, uid: child.uid, startSec: captured.sec, startUsec: captured.usec,
      executable: request.executable });
    return Object.freeze({ child: Object.freeze({ ...child }), handle, identity });
  } catch { return null; }
}

export function createMacConnectedPeerVerifier(seal: MacProcessSeal, proof: NativePeerProofPort): ConnectedPeerVerifier {
  const expected = copyCoreChild(seal.child);
  const identity = Object.freeze({ ...seal.identity,
    executable: Object.freeze({ dev: seal.identity.executable.dev, ino: seal.identity.executable.ino }) });
  const handle = seal.handle;
  const matches = (child: OwnedChild) => {
    try { return sameChild(copyCoreChild(child), expected) && live(handle) && handle.pid === expected.pid; }
    catch { return false; }
  };
  const currentProof = async (child: OwnedChild, signal?: AbortSignal): Promise<PeerVerdict> => {
    if (!matches(child) || signal?.aborted) return 'UNKNOWN';
    try {
      const verdict = await bounded(signal, s => proof.current(identity, s));
      if (!matches(child)) return 'UNKNOWN';
      return verdict === 'OWNED' || verdict === 'FOREIGN' ? verdict : 'UNKNOWN';
    } catch { return 'UNKNOWN'; }
  };
  return Object.freeze({
    async current(child: OwnedChild) { return await currentProof(child) === 'OWNED'; },
    async verify(socket: Socket, child: OwnedChild, signal: AbortSignal) {
      const ports = tuple(socket);
      if (ports === null || !matches(child) || signal.aborted) return 'UNKNOWN';
      const before = await currentProof(child, signal);
      if (before !== 'OWNED') return before;
      try {
        const verdict = await bounded(signal, s => proof.peer(Object.freeze({ ...identity, ...ports }), s));
        if (verdict !== 'OWNED') return verdict === 'FOREIGN' ? 'FOREIGN' : 'UNKNOWN';
        if (!matches(child) || signal.aborted) return 'UNKNOWN';
        return await currentProof(child, signal) === 'OWNED' ? 'OWNED' : 'UNKNOWN';
      } catch { return 'UNKNOWN'; }
    },
  });
}
