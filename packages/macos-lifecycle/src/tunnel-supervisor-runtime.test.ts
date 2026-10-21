import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import type { CoreEvidence } from './health-probe.js';
import { createReviewedTunnelSupervisor, type ReviewedTunnelProvider } from './tunnel-supervisor-runtime.js';
import { TunnelRegistrationStore } from './tunnel-registration.js';
import type { ReviewedTunnelRuntime } from './adapters/runtime-authority.js';
import type { NativePeerProofPort, PeerVerdict } from './adapters/owned-process.js';
import { MemoryExecutionFiles, releaseDigest } from './test-support/execution-fixture.js';

const signal = () => new AbortController().signal;
const compatibilityDigest = 'b'.repeat(64);
const config = parseConfig({
  schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-tunnel',
  releaseDigest, tunnel: { enabled: true, compatibilityDigest, credentialRef: 'test-tunnel-key' },
});
const core: CoreEvidence = Object.freeze({
  state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: 'core-g1', releaseDigest, observedAtMs: 1,
});

async function fixture(input: { credential?: unknown; observation?: unknown; onProbe?: (set: (value: PeerVerdict) => void) => unknown } = {}) {
  const files = new MemoryExecutionFiles(); const execution = new ExecutionLeaseStore(files);
  await execution.initializeNew('tunnel');
  const tunnelRegistration = new TunnelRegistrationStore(new MemoryExecutionFiles(), execution);
  let verdict: PeerVerdict = 'OWNED'; let launches = 0; let credentialCalls = 0; let probes = 0;
  const proof: NativePeerProofPort = Object.freeze({
    async capture() { return { sec: '1700000000', usec: '21' }; },
    async current() { return verdict; },
    async peer() { return 'UNKNOWN'; },
  });
  const tunnelRuntime: ReviewedTunnelRuntime = Object.freeze({
    compatibility: Object.freeze({ digest: compatibilityDigest }),
    authority: Object.freeze({
      async acquire(request, compatibility) {
        if (configDigest(request) !== configDigest(config) || compatibility.digest !== compatibilityDigest) return null;
        expect((await execution.read('tunnel')).state).toBe('HELD');
        return Object.freeze({
          configDigest: configDigest(config), compatibilityDigest,
          account: Object.freeze({ name: 'gram-agent' as const, uid: process.getuid?.() ?? 501,
            gid: process.getgid?.() ?? 20, admin: false }),
          executable: Object.freeze({ dev: 11n, ino: 22n }), proof,
        });
      },
    }),
  });
  const provider: ReviewedTunnelProvider = {
    async credentialAvailable() { credentialCalls++; return (input.credential ?? true) as boolean; },
    launch() {
      launches++;
      return spawn(process.execPath, ['-e',
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),5));setInterval(()=>{},1000);"
      ], { stdio: ['ignore','pipe','pipe'] });
    },
    async probe() { probes++; return (input.onProbe ? input.onProbe(value => { verdict = value; }) : (input.observation ?? 'READY')) as 'READY'; },
  };
  const port = createReviewedTunnelSupervisor({ configuration: config, execution, tunnelRegistration, tunnelRuntime }, provider);
  return { execution, provider, port, setVerdict(v: PeerVerdict) { verdict = v; },
    launches: () => launches, credentialCalls: () => credentialCalls, probes: () => probes };
}

describe('reviewed tunnel supervisor composition', () => {
  it('has no construction-time credential, launch or provider-health effects', async () => {
    const f = await fixture();
    expect(f.port).not.toBeNull();
    expect(f.launches()).toBe(0); expect(f.credentialCalls()).toBe(0); expect(f.probes()).toBe(0);
    expect((await f.execution.read('tunnel')).state).toBe('FREE');
  });

  it('returns only the reviewed compatibility for the exact reviewed config', async () => {
    const f = await fixture(); if (!f.port) throw new Error('missing port');
    expect(await f.port.compatibility(config)).toEqual({ digest: compatibilityDigest });
    expect(await f.port.compatibility({ ...config, releaseId: 'other' })).toBeNull();
  });

  it('normalizes credential availability to literal true and does not launch during the check', async () => {
    const good = await fixture({ credential: true }); if (!good.port) throw new Error('missing');
    expect(await good.port.credentialAvailable('test-tunnel-key')).toBe(true);
    expect(good.launches()).toBe(0);

    const unknown = await fixture({ credential: 'UNKNOWN' }); if (!unknown.port) throw new Error('missing');
    expect(await unknown.port.credentialAvailable('test-tunnel-key')).toBe(false);
    expect(unknown.launches()).toBe(0);
  });

  it('refuses spawn unless the one-shot credential gate was opened', async () => {
    const f = await fixture(); if (!f.port) throw new Error('missing port');
    await expect(f.port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal()))
      .rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(f.launches()).toBe(0);
    expect((await f.execution.read('tunnel')).state).toBe('FREE');
  });

  it('launches through reviewed custody after the credential gate and stops with lease release', async () => {
    const f = await fixture(); if (!f.port) throw new Error('missing port');
    expect(await f.port.credentialAvailable('test-tunnel-key')).toBe(true);
    const managed = await f.port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    expect(f.launches()).toBe(1); expect((await f.execution.read('tunnel')).state).toBe('HELD');
    await f.port.stop(managed, 20000, signal()); await managed.exited;
    expect((await f.execution.read('tunnel')).state).toBe('FREE');
  });

  it('requires current native ownership both before and after provider health', async () => {
    const f = await fixture(); if (!f.port) throw new Error('missing port');
    await f.port.credentialAvailable('test-tunnel-key');
    const managed = await f.port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    expect(await f.port.probe(managed.child, core, signal())).toBe('READY');
    expect(f.probes()).toBe(1);

    f.setVerdict('FOREIGN');
    expect(await f.port.probe(managed.child, core, signal())).toBe('UNKNOWN');
    expect(f.probes()).toBe(1);
    f.setVerdict('OWNED');
    await f.port.stop(managed, 20000, signal());
  });

  it('downgrades a provider observation when ownership changes during the probe', async () => {
    const f = await fixture({ onProbe(set) { set('FOREIGN'); return 'READY'; } });
    if (!f.port) throw new Error('missing port');
    await f.port.credentialAvailable('test-tunnel-key');
    const managed = await f.port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    expect(await f.port.probe(managed.child, core, signal())).toBe('UNKNOWN');
    f.setVerdict('OWNED'); await f.port.stop(managed, 20000, signal());
  });

  it('downgrades unknown provider response values instead of treating truthy values as readiness', async () => {
    const f = await fixture({ observation: 'READYISH' }); if (!f.port) throw new Error('missing port');
    await f.port.credentialAvailable('test-tunnel-key');
    const managed = await f.port.spawn(config, { digest: compatibilityDigest }, core, 'tg1', signal());
    expect(await f.port.probe(managed.child, core, signal())).toBe('UNKNOWN');
    await f.port.stop(managed, 20000, signal());
  });
});
