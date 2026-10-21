import { describe, expect, it } from 'vitest';
import type { Socket } from 'node:net';
import {
  createMacConnectedPeerVerifier,
  sealMacOwnedChild,
  sealMacOwnedProcess,
  type LiveProcessHandle,
  type MacProcessSeal,
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
async function maybeSeal(p = proof(), h = handle()) {
  return sealMacOwnedChild(h, {
    role: 'core', uid: 501, generation: 'gen-1', releaseDigest: digest,
    executable: { dev: 11n, ino: 22n },
  }, p, new AbortController().signal);
}
async function sealed(p = proof(), h = handle()): Promise<MacProcessSeal> {
  const value = await maybeSeal(p, h);
  if (value === null) throw new Error('seal expected');
  return value;
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
      { exitCode: null, signalCode: null, killed: false },
    ]) expect(await sealMacOwnedChild(h, {
      role: 'core', uid: 501, generation: 'gen-1', releaseDigest: digest,
      executable: { dev: 11n, ino: 22n },
    }, proof(), new AbortController().signal)).toBeNull();

    const bad = proof(); bad.capture = async () => ({ sec: 'x', usec: '1' });
    expect(await maybeSeal(bad)).toBeNull();
  });
});

describe('tunnel connected peer uses sealed identity and the fixed health tuple', () => {
  async function tunnel(p = proof(), h = handle()) {
    const s = await sealMacOwnedProcess(h, { role: 'tunnel', uid: 501, generation: 'tg1',
      releaseDigest: digest, executable: { dev: 11n, ino: 22n } }, p, new AbortController().signal);
    if (!s) throw new Error('seal expected');
    return { s, verifier: createMacConnectedPeerVerifier(s, p) };
  }

  it('attributes the fixed health tuple to the sealed tunnel executable', async () => {
    const p = proof();
    p.peer = async request => request.pid === 4242 && request.uid === 501
      && request.startSec === '1700000000' && request.startUsec === '123456'
      && request.executable.dev === 11n && request.executable.ino === 22n
      && request.serverPort === 8080 && request.clientPort === 51000 ? 'OWNED' : 'FOREIGN';
    const { s, verifier } = await tunnel(p);
    expect(await verifier.verify(socket(51000, 8080), s.child, new AbortController().signal)).toBe('OWNED');
  });

  it('rejects foreign role, PID, UID, start, generation and release identities', async () => {
    const { s, verifier } = await tunnel();
    for (const patch of [{ role: 'core' as const }, { pid: 4243 }, { uid: 502 },
      { startIdentity: '1700000000.1' }, { generation: 'tg2' }, { releaseDigest: 'b'.repeat(64) }]) {
      expect(await verifier.verify(socket(51000, 8080), { ...s.child, ...patch },
        new AbortController().signal)).toBe('UNKNOWN');
    }
  });

  it('refuses any other port or nonloopback tuple', async () => {
    const { s, verifier } = await tunnel();
    for (const peer of [socket(51000, 3847), socket(51000, 8081),
      { ...socket(51000, 8080), remoteAddress: '::1' } as Socket]) {
      expect(await verifier.verify(peer, s.child, new AbortController().signal)).toBe('UNKNOWN');
    }
  });

  it('rejects a changed tuple during either native proof bracket', async () => {
    for (const stage of ['peer', 'current'] as const) {
      const p = proof(); const peer = socket(51000, 8080); let calls = 0;
      if (stage === 'peer') p.peer = async () => { Object.assign(peer, { localPort: 51001 }); return 'OWNED'; };
      else p.current = async () => { if (++calls === 2) Object.assign(peer, { remotePort: 8081 }); return 'OWNED'; };
      const { s, verifier } = await tunnel(p);
      expect(await verifier.verify(peer, s.child, new AbortController().signal)).toBe('UNKNOWN');
    }
  });

  it('fails closed on process reuse, executable mismatch, exit or cancellation', async () => {
    for (const stage of ['current', 'peer', 'exit', 'abort'] as const) {
      const p = proof(); const h = handle(); const abort = new AbortController();
      if (stage === 'current') p.current = async () => 'FOREIGN';
      if (stage === 'peer') p.peer = async () => 'FOREIGN';
      if (stage === 'exit') p.peer = async () => { h.exitCode = 0; return 'OWNED'; };
      if (stage === 'abort') p.peer = async () => { abort.abort(); return 'OWNED'; };
      const { s, verifier } = await tunnel(p, h);
      expect(await verifier.verify(socket(51000, 8080), s.child, abort.signal)).toBe(
        stage === 'current' || stage === 'peer' ? 'FOREIGN' : 'UNKNOWN');
    }
  });

  it('refuses late cancellation during the final identity recheck', async () => {
    const p = proof(); const abort = new AbortController(); let calls = 0;
    p.current = async () => { if (++calls === 2) abort.abort(); return 'OWNED'; };
    const { s, verifier } = await tunnel(p);
    expect(await verifier.verify(socket(51000, 8080), s.child, abort.signal)).toBe('UNKNOWN');
  });

  it('rejects non-plain and accessor tunnel identities before evaluating getters', async () => {
    const { s, verifier } = await tunnel(); let reads = 0;
    const inherited = Object.assign(Object.create({ inherited: true }), s.child) as typeof s.child;
    expect(await verifier.current(inherited)).toBe(false);
    for (const key of ['role', 'pid'] as const) {
      const accessor = { ...s.child };
      Object.defineProperty(accessor, key, { enumerable: true, get() { reads++; return s.child[key]; } });
      expect(await verifier.verify(socket(51000, 8080), accessor, new AbortController().signal)).toBe('UNKNOWN');
    }
    expect(reads).toBe(0);
  });
});

describe('live verifier rechecks handle, process and accepted socket', () => {
  it('preserves Core rejection of non-plain identity records without reading accessors', async () => {
    const s = await sealed(); const verifier = createMacConnectedPeerVerifier(s, proof());
    const inherited = Object.assign(Object.create({ inherited: true }), s.child) as typeof s.child;
    expect(await verifier.current(inherited)).toBe(false);
    const accessor = { ...s.child }; let read = false;
    Object.defineProperty(accessor, 'role', { enumerable: true, get() { read = true; return 'core'; } });
    expect(await verifier.current(accessor)).toBe(false);
    expect(read).toBe(false);
  });

  it('rejects any child identity mismatch before native proof', async () => {
    const trace: string[] = []; const p = proof(trace); const s = await sealed(p);
    trace.length = 0;
    const verifier = createMacConnectedPeerVerifier(s, p);
    expect(await verifier.current({ ...s.child, generation: 'other' })).toBe(false);
    expect(trace).toEqual([]);
  });

  it('requires current proof around an OWNED accepted-socket proof', async () => {
    const trace: string[] = []; const p = proof(trace); const s = await sealed(p);
    trace.length = 0;
    const verifier = createMacConnectedPeerVerifier(s, p);
    expect(await verifier.verify(socket(), s.child, new AbortController().signal)).toBe('OWNED');
    expect(trace).toEqual([
      'current:4242:1700000000.123456',
      'peer:3847:51000',
      'current:4242:1700000000.123456',
    ]);
  });

  it('fails closed if the handle exits after socket proof or the tuple is not loopback TCP', async () => {
    const h = handle(); const p = proof(); const s = await sealed(p, h);
    p.peer = async () => { h.exitCode = 0; return 'OWNED'; };
    expect(await createMacConnectedPeerVerifier(s, p).verify(socket(), s.child, new AbortController().signal))
      .toBe('UNKNOWN');

    const h2 = handle(); const p2 = proof(); const s2 = await sealed(p2, h2);
    const badSocket = { localAddress: '0.0.0.0', remoteAddress: '127.0.0.1',
      localPort: 51000, remotePort: 3847 } as Socket;
    expect(await createMacConnectedPeerVerifier(s2, p2).verify(badSocket, s2.child, new AbortController().signal))
      .toBe('UNKNOWN');
  });

  it('maps FOREIGN/UNKNOWN without ever upgrading them to OWNED', async () => {
    for (const verdict of ['FOREIGN', 'UNKNOWN'] as const) {
      const p = proof(); p.peer = async () => verdict; const s = await sealed(p);
      expect(await createMacConnectedPeerVerifier(s, p).verify(socket(), s.child, new AbortController().signal))
        .toBe(verdict);
    }
  });
});
