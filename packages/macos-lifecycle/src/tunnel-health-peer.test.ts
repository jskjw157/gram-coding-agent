import { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';
import { createNativeTunnelCustody, type TunnelCustodyPort } from './adapters/native-tunnel.js';
import type { NativePeerProofPort, PeerVerdict } from './adapters/owned-process.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import { withExclusiveTunnelCustody } from './exclusive-tunnel.js';
import { withRegisteredTunnel } from './registered-tunnel.js';
import { TunnelRegistrationStore } from './tunnel-registration.js';
import { createReviewedTunnelSupervisor, type ReviewedTunnelProvider } from './tunnel-supervisor-runtime.js';
import type { CoreEvidence } from './health-probe.js';
import { MemoryExecutionFiles } from './test-support/execution-fixture.js';
import { parseOfficialReadyz } from './official-tunnel-health.js';

const releaseDigest = 'a'.repeat(64); const compatibilityDigest = 'b'.repeat(64);
const config = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent',
  releaseId: 'peer-fixture', releaseDigest,
  tunnel: { enabled: true, compatibilityDigest, credentialRef: 'test-tunnel-key' } });
const core: CoreEvidence = Object.freeze({ state: 'LOCAL_CORE_HEALTHY', code: 'OK',
  generation: 'cg1', releaseDigest, observedAtMs: 1 });
const signal = () => new AbortController().signal;
const socket = (port = 8080) => ({ localAddress: '127.0.0.1', remoteAddress: '127.0.0.1',
  localPort: 51000, remotePort: port, destroyed: false, connecting: false }) as Socket;

// Unspawned ChildProcess and structural socket data only: no OS process,
// listener, native helper, credential, or HTTP request is created by this suite.
async function fixture() {
  const raw = new ChildProcess(); Object.defineProperty(raw, 'pid', { value: 4242 });
  raw.stdout = null; raw.stderr = null;
  raw.kill = () => { raw.emit('exit', 0, null); return true; };
  let verdict: PeerVerdict = 'OWNED'; let onPeer = () => {};
  const proof: NativePeerProofPort = {
    async capture() { return { sec: '1700000000', usec: '21' }; },
    async current() { return verdict; },
    async peer(request) {
      onPeer();
      return request.serverPort === 8080 && request.clientPort === 51000 ? verdict : 'FOREIGN';
    },
  };
  const execution = new ExecutionLeaseStore(new MemoryExecutionFiles());
  await execution.initializeNew('tunnel');
  const registration = new TunnelRegistrationStore(new MemoryExecutionFiles(), execution);
  const authority = { async acquire() { return { configDigest: configDigest(config), compatibilityDigest,
    account: { name: 'gram-agent' as const, uid: process.getuid?.() ?? 501,
      gid: process.getgid?.() ?? 20, admin: false as const },
    executable: { dev: 11n, ino: 22n }, proof }; } };
  const launch = () => { queueMicrotask(() => raw.emit('spawn')); return raw; };
  const native = createNativeTunnelCustody({ authority, launch });
  const exclusive = withExclusiveTunnelCustody(native, execution);
  const registered = withRegisteredTunnel(exclusive, registration);
  return { raw, native, exclusive, registered, execution, authority, launch, registration,
    verdict(v: PeerVerdict) { verdict = v; }, onPeer(fn: () => void) { onPeer = fn; } };
}
async function verify(port: TunnelCustodyPort, child: Parameters<TunnelCustodyPort['current']>[0],
  peer = socket(), active = signal()) {
  return port.verifyHealthPeer ? await port.verifyHealthPeer(child, peer, active) : 'UNKNOWN';
}

describe('health peer forwarding retains exact tunnel custody', () => {
  for (const layer of ['native', 'exclusive', 'registered'] as const) {
    it(`${layer}: attributes only the active fixed-loopback responder`, async () => {
      const f = await fixture(); const port = f[layer];
      const managed = await port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
      try {
        expect(await verify(port, managed.child)).toBe('OWNED');
        expect(await verify(port, { ...managed.child, role: 'core' })).toBe('UNKNOWN');
        expect(await verify(port, { ...managed.child, generation: 'other' })).toBe('UNKNOWN');
        expect(await verify(port, managed.child, socket(3847))).toBe('UNKNOWN');
        f.verdict('FOREIGN'); expect(await verify(port, managed.child)).toBe('FOREIGN');
        f.verdict('OWNED');
        const abort = new AbortController(); abort.abort();
        expect(await verify(port, managed.child, socket(), abort.signal)).toBe('UNKNOWN');
      } finally { f.raw.emit('exit', 0, null); await managed.exited; }
      expect(await verify(port, managed.child)).toBe('UNKNOWN');
    });

    it(`${layer}: rejects exit, cancellation and socket replacement during proof`, async () => {
      for (const change of ['exit', 'abort', 'tuple', 'reconnect'] as const) {
        const f = await fixture(); const port = f[layer]; const abort = new AbortController(); const peer = socket();
        const managed = await port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
        f.onPeer(() => {
          if (change === 'exit') f.raw.emit('exit', 0, null);
          if (change === 'abort') abort.abort();
          if (change === 'tuple') Object.assign(peer, { localPort: 51001 });
          if (change === 'reconnect') Object.assign(peer, { connecting: true });
        });
        try { expect(await verify(port, managed.child, peer, abort.signal)).toBe('UNKNOWN'); }
        finally { f.raw.emit('exit', 0, null); await managed.exited; }
      }
    });

    it(`${layer}: rejects accessor and non-plain input without invoking caller getters`, async () => {
      const f = await fixture(); const port = f[layer]; let reads = 0;
      const managed = await port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
      try {
        const inherited = Object.assign(Object.create({ inherited: true }), managed.child) as typeof managed.child;
        expect(await verify(port, inherited)).toBe('UNKNOWN');
        for (const key of ['role', 'pid'] as const) {
          const accessor = { ...managed.child };
          Object.defineProperty(accessor, key, { enumerable: true, get() { reads++; return managed.child[key]; } });
          expect(await verify(port, accessor)).toBe('UNKNOWN');
        }
        expect(reads).toBe(0);
      } finally { f.raw.emit('exit', 0, null); await managed.exited; }
    });
  }

  it('registration does not expose a verifier before publication completes', async () => {
    const f = await fixture(); let publish = () => {};
    const gate = new Promise<void>(resolve => { publish = resolve; });
    let captured: Parameters<TunnelCustodyPort['current']>[0] | undefined;
    let entered = () => {};
    const publishing = new Promise<void>(resolve => { entered = resolve; });
    const port = withRegisteredTunnel(f.exclusive, { async publish(input, child) {
      captured = child; entered(); await gate; return f.registration.publish(input, child);
    } });
    const starting = port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    await Promise.race([publishing, starting]);
    if (!captured) throw new Error('publication expected');
    expect(await verify(port, captured)).toBe('UNKNOWN');
    publish(); const managed = await starting;
    try { expect(await verify(port, managed.child)).toBe('OWNED'); }
    finally { f.raw.emit('exit', 0, null); await managed.exited; }
  });
});

describe('provider gets a verifier scoped to the exact probe lifetime', () => {
  it('rejects malformed probe children before getters or provider observation', async () => {
    const f = await fixture(); let reads = 0; let probes = 0;
    const provider: ReviewedTunnelProvider = { async credentialAvailable() { return true; }, launch: f.launch,
      async probe() { probes++; return 'READY'; } };
    const port = createReviewedTunnelSupervisor({ configuration: config, execution: f.execution,
      tunnelRegistration: f.registration, tunnelRuntime: { compatibility: { digest: compatibilityDigest },
        authority: f.authority } }, provider);
    if (!port) throw new Error('supervisor expected');
    await port.credentialAvailable('test-tunnel-key');
    const managed = await port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    try {
      const inherited = Object.assign(Object.create({ inherited: true }), managed.child) as typeof managed.child;
      expect(await port.probe(inherited, core, signal())).toBe('UNKNOWN');
      for (const key of ['role', 'pid'] as const) {
        const accessor = { ...managed.child };
        Object.defineProperty(accessor, key, { enumerable: true, get() { reads++; return managed.child[key]; } });
        expect(await port.probe(accessor, core, signal())).toBe('UNKNOWN');
      }
      expect(reads).toBe(0); expect(probes).toBe(0);
    } finally { f.raw.emit('exit', 0, null); await managed.exited; }
  });

  it('forwards through registered native custody and revokes after the probe', async () => {
    const f = await fixture(); let retained: (() => Promise<PeerVerdict>) | undefined;
    let observed: PeerVerdict = 'UNKNOWN'; let peerCalls = 0; f.onPeer(() => { peerCalls++; });
    const provider: ReviewedTunnelProvider = { async credentialAvailable() { return true; }, launch: f.launch,
      async probe(_child, _core, _signal, verifyHealthPeer) {
        retained = () => verifyHealthPeer(socket());
        observed = await retained();
        return 'UNKNOWN';
      } };
    const port = createReviewedTunnelSupervisor({ configuration: config, execution: f.execution,
      tunnelRegistration: f.registration, tunnelRuntime: { compatibility: { digest: compatibilityDigest },
        authority: f.authority } }, provider);
    if (!port) throw new Error('supervisor expected');
    await port.credentialAvailable('test-tunnel-key');
    const managed = await port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    try {
      expect(await port.probe(managed.child, core, signal())).toBe('UNKNOWN');
      expect(observed).toBe('OWNED');
      expect(peerCalls).toBe(1);
      if (!retained) throw new Error('verifier expected');
      expect(await retained()).toBe('UNKNOWN');
      expect(peerCalls).toBe(1);
    } finally { f.raw.emit('exit', 0, null); await managed.exited; }
    expect((await f.execution.read('tunnel')).state).toBe('FREE');
  });

  it('revokes the callback before native proof when the probe signal is aborted', async () => {
    const f = await fixture(); const abort = new AbortController(); let peerCalls = 0;
    f.onPeer(() => { peerCalls++; }); let observed: PeerVerdict = 'OWNED';
    const provider: ReviewedTunnelProvider = { async credentialAvailable() { return true; }, launch: f.launch,
      async probe(_child, _core, _signal, verifyHealthPeer) {
        abort.abort(); observed = await verifyHealthPeer(socket()); return 'READY';
      } };
    const port = createReviewedTunnelSupervisor({ configuration: config, execution: f.execution,
      tunnelRegistration: f.registration, tunnelRuntime: { compatibility: { digest: compatibilityDigest },
        authority: f.authority } }, provider);
    if (!port) throw new Error('supervisor expected');
    await port.credentialAvailable('test-tunnel-key');
    const managed = await port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    try {
      expect(await port.probe(managed.child, core, abort.signal)).toBe('UNKNOWN');
      expect(observed).toBe('UNKNOWN'); expect(peerCalls).toBe(0);
    } finally { f.raw.emit('exit', 0, null); await managed.exited; }
  });

  it('does not convert a parsed HTTP ready fact into supervisor READY', async () => {
    const f = await fixture();
    const provider: ReviewedTunnelProvider = { async credentialAvailable() { return true; }, launch: f.launch,
      async probe() { return parseOfficialReadyz(200, 'ready') as 'UNKNOWN'; } };
    const port = createReviewedTunnelSupervisor({ configuration: config, execution: f.execution,
      tunnelRegistration: f.registration, tunnelRuntime: { compatibility: { digest: compatibilityDigest },
        authority: f.authority } }, provider);
    if (!port) throw new Error('supervisor expected');
    await port.credentialAvailable('test-tunnel-key');
    const managed = await port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    try { expect(await port.probe(managed.child, core, signal())).toBe('UNKNOWN'); }
    finally { f.raw.emit('exit', 0, null); await managed.exited; }
  });
});
