import { describe, expect, it } from 'vitest';
import type { Socket } from 'node:net';
import {
  createMacConnectedPeerVerifier,
  sealMacOwnedChild,
  type LiveProcessHandle,
  type NativePeerProofPort,
} from './owned-process.js';

const digest = 'a'.repeat(64);
function handle(): LiveProcessHandle {
  return { pid: 4242, exitCode: null, signalCode: null, killed: false };
}
function proof(trace: string[] = []): NativePeerProofPort {
  return {
    async capture(request) {
      trace.push(`capture:${request.pid}`);
      return { sec: '1700000000', usec: '123456' };
    },
    async current(request) {
      trace.push(`current:${request.pid}:${request.startSec}.${request.startUsec}`);
      return 'OWNED';
    },
    async peer(request) {
      trace.push(`peer:${request.serverPort}:${request.clientPort}`);
      return 'OWNED';
    },
  };
}
async function sealed(p = proof(), h = handle()) {
  return sealMacOwnedChild(h, {
    role: 'core', uid: 501, generation: 'gen-1', releaseDigest: digest,
    executable: { dev: 11n, ino: 22n },
  }, p, new AbortController().signal);
}
function socket(localPort = 51000, remotePort = 3847): Socket {
  return { localAddress: '127.0.0.1', remoteAddress: '127.0.0.1', localPort, remotePort } as Socket;
}

describe('kernel-bound live child seal', () => {
  it('captures kernel start identity and detaches caller-owned identity data', async () => {
    const input = { role: 'core' as const, uid: 501, generation: 'gen-1', releaseDigest: digest,
      executable: { dev: 11n, ino: 22n } };
    const s = await sealMacOwnedChild(handle(), input, proof(), new AbortController().signal);
    expect(s?.child).toEqual({ role: 'core', pid: 4242, uid: 501, generation: 'gen-1',
      releaseDigest: digest, startIdentity: '1700000000.123456' });
    input.generation = 'changed';
    expect(s?.child.generation).toBe('gen-1');
  });

  it('refuses exited/killed handles and invalid kernel capture before sealing', async () => {
    for (const h of [
      { pid: 4242, exitCode: 1, signalCode: null, killed: false },
      { pid: 4242, exitCode: null, signalCode: 'SIGTERM' as NodeJS.Signals, killed: false },
      { pid: 4242, exitCode: null, signalCode: null, killed: true },
      { pid: undefined, exitCode: null, signalCode: null, killed: false },
    ]) expect(await sealMacOwnedChild(h, {
      role: 'core', uid: 501, generation: 'gen-1', releaseDigest: digest,
      executable: { dev: 11n, ino: 22n },
    }, proof(), new AbortController().signal)).toBeNull();

    const bad = proof(); bad.capture = async () => ({ sec: 'x', usec: '1' });
    expect(await sealed(bad)).toBeNull();
  });
});

describe('live verifier rechecks handle, process and accepted socket', () => {
  it('rejects any child identity mismatch before native proof', async () => {
    const trace: string[] = []; const s = await sealed(proof(trace));
    expect(s).not.toBeNull();
    const verifier = createMacConnectedPeerVerifier(s!, proof(trace));
    trace.length = 0;
    expect(await verifier.current({ ...s!.child, generation: 'other' })).toBe(false);
    expect(trace).toEqual([]);
  });

  it('requires current proof around an OWNED accepted-socket proof', async () => {
    const trace: string[] = []; const p = proof(trace); const s = await sealed(p);
    expect(s).not.toBeNull(); trace.length = 0;
    const verifier = createMacConnectedPeerVerifier(s!, p);
    expect(await verifier.verify(socket(), s!.child, new AbortController().signal)).toBe('OWNED');
    expect(trace).toEqual([
      'current:4242:1700000000.123456',
      'peer:3847:51000',
      'current:4242:1700000000.123456',
    ]);
  });

  it('fails closed if the handle exits after socket proof or the tuple is not loopback TCP', async () => {
    const h = handle(); const p = proof(); const s = await sealed(p, h); expect(s).not.toBeNull();
    p.peer = async () => { h.exitCode = 0; return 'OWNED'; };
    expect(await createMacConnectedPeerVerifier(s!, p).verify(socket(), s!.child, new AbortController().signal))
      .toBe('UNKNOWN');

    const h2 = handle(); const p2 = proof(); const s2 = await sealed(p2, h2); expect(s2).not.toBeNull();
    const badSocket = { localAddress: '0.0.0.0', remoteAddress: '127.0.0.1',
      localPort: 51000, remotePort: 3847 } as Socket;
    expect(await createMacConnectedPeerVerifier(s2!, p2).verify(badSocket, s2!.child, new AbortController().signal))
      .toBe('UNKNOWN');
  });

  it('maps FOREIGN/UNKNOWN without ever upgrading them to OWNED', async () => {
    for (const verdict of ['FOREIGN', 'UNKNOWN'] as const) {
      const p = proof(); p.peer = async () => verdict; const s = await sealed(p); expect(s).not.toBeNull();
      expect(await createMacConnectedPeerVerifier(s!, p).verify(socket(), s!.child, new AbortController().signal))
        .toBe(verdict);
    }
  });
});
