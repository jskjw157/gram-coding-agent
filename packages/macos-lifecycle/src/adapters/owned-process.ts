import { spawn } from 'node:child_process';
import type { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
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
function safeHelperPath(value: string): boolean {
  return process.platform === 'darwin' && isAbsolute(value) && value.length <= 4096
    && ![...value].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}
async function runHelper(helper: string, args: string[], parent: AbortSignal): Promise<string | null> {
  if (!safeHelperPath(helper) || parent.aborted || args.some(a => !DECIMAL.test(a) || a.length > 20)) return null;
  return await new Promise(resolve => {
    let child;
    try {
      child = spawn(helper, args, { shell: false, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { resolve(null); return; }
    let done = false; let size = 0; const chunks: Buffer[] = [];
    const finish = (value: string | null) => {
      if (done) return; done = true; clearTimeout(timer); parent.removeEventListener('abort', abort); resolve(value);
    };
    const abort = () => { child.kill('SIGKILL'); finish(null); };
    const timer = setTimeout(abort, 2000);
    parent.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!Buffer.isBuffer(chunk) || size + chunk.length > 256) { abort(); return; }
      size += chunk.length; chunks.push(Buffer.from(chunk));
    });
    child.stderr?.on('data', abort);
    child.once('error', () => finish(null));
    child.once('close', (code, signal) => {
      if (code !== 0 || signal !== null) { finish(null); return; }
      const bytes = Buffer.concat(chunks, size); const value = bytes.toString('utf8');
      if (!Buffer.from(value, 'utf8').equals(bytes)) finish(null); else finish(value);
    });
    if (parent.aborted) abort();
  });
}
function baseArgs(value: Omit<NativeProcessIdentity, 'startSec' | 'startUsec'>): string[] | null {
  if (!Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > 0x7fff_ffff
    || !Number.isSafeInteger(value.uid) || value.uid < 1 || value.uid >= 0xffff_ffff
    || !validExecutable(value.executable)) return null;
  return [String(value.pid), String(value.uid), value.executable.dev.toString(), value.executable.ino.toString()];
}
function identityArgs(value: NativeProcessIdentity): string[] | null {
  const base = baseArgs(value);
  if (base === null || !validUint(value.startSec) || !validUsec(value.startUsec)) return null;
  return [base[0] ?? '', base[1] ?? '', value.startSec, value.startUsec, base[2] ?? '', base[3] ?? ''];
}
function verdict(value: string | null): PeerVerdict {
  if (value === 'OWNED\n') return 'OWNED';
  if (value === 'FOREIGN\n') return 'FOREIGN';
  return 'UNKNOWN';
}

/** Native helper arguments are numeric identity and loopback tuple values only.
 * Its output is a closed token; paths, credentials, protocol bodies and native
 * error text are never returned through this port. */
export function createNativePeerProof(helper: string): NativePeerProofPort {
  return Object.freeze({
    async capture(request, signal) {
      const args = baseArgs(request); if (args === null) return null;
      const output = await runHelper(helper, args, signal);
      const match = /^START ([0-9]+) ([0-9]+)\n$/u.exec(output ?? '');
      if (!match || !validUint(match[1] ?? '') || !validUsec(match[2] ?? '')) return null;
      return { sec: match[1] as string, usec: match[2] as string };
    },
    async current(request, signal) {
      const args = identityArgs(request); return args === null ? 'UNKNOWN' : verdict(await runHelper(helper, args, signal));
    },
    async peer(request, signal) {
      const args = identityArgs(request);
      if (args === null || !Number.isSafeInteger(request.serverPort) || request.serverPort < 1 || request.serverPort > 65535
        || !Number.isSafeInteger(request.clientPort) || request.clientPort < 1 || request.clientPort > 65535) return 'UNKNOWN';
      return verdict(await runHelper(helper, [...args, String(request.serverPort), String(request.clientPort)], signal));
    },
  });
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
      const result = await bounded(signal, s => proof.current(identity, s));
      if (!matches(child)) return 'UNKNOWN';
      return result === 'OWNED' || result === 'FOREIGN' ? result : 'UNKNOWN';
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
        const result = await bounded(signal, s => proof.peer(Object.freeze({ ...identity, ...ports }), s));
        if (result !== 'OWNED') return result === 'FOREIGN' ? 'FOREIGN' : 'UNKNOWN';
        if (!matches(child) || signal.aborted) return 'UNKNOWN';
        return await currentProof(child, signal) === 'OWNED' ? 'OWNED' : 'UNKNOWN';
      } catch { return 'UNKNOWN'; }
    },
  });
}
