import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configDigest, parseConfig } from './config.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import type { CoreEvidence } from './health-probe.js';
import { createReviewedTunnelCustody } from './tunnel-runtime.js';
import { TunnelRegistrationStore } from './tunnel-registration.js';
import type { ReviewedTunnelRuntime } from './adapters/runtime-authority.js';
import type { TunnelLaunchPlan } from './adapters/native-tunnel.js';
import type { NativePeerProofPort } from './adapters/owned-process.js';
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
const proof: NativePeerProofPort = Object.freeze({
  async capture() { return { sec: '1700000000', usec: '9' }; },
  async current() { return 'OWNED'; },
  async peer() { return 'UNKNOWN'; },
});

async function fixture(enabled = true) {
  const files = new MemoryExecutionFiles();
  const execution = new ExecutionLeaseStore(files);
  if (enabled) await execution.initializeNew('tunnel');
  const tunnelRegistration = new TunnelRegistrationStore(new MemoryExecutionFiles(), execution);
  let authorityCalls = 0;
  const tunnelRuntime: ReviewedTunnelRuntime = Object.freeze({
    compatibility: Object.freeze({ digest: compatibilityDigest }),
    authority: Object.freeze({
      async acquire(input, compatibility) {
        authorityCalls++;
        expect((await execution.read('tunnel')).state).toBe('HELD');
        if (configDigest(input) !== configDigest(config) || compatibility.digest !== compatibilityDigest) return null;
        return Object.freeze({
          configDigest: configDigest(config), compatibilityDigest,
          account: Object.freeze({ name: 'gram-agent' as const, uid: process.getuid?.() ?? 501,
            gid: process.getgid?.() ?? 20, admin: false }),
          executable: Object.freeze({ dev: 11n, ino: 22n }),
          proof,
        });
      },
    }),
  });
  return { files, execution, tunnelRegistration, tunnelRuntime, authorityCalls: () => authorityCalls };
}

function child(): ChildProcess {
  return spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),5));setInterval(()=>{},1000);"
  ], { stdio: ['ignore','pipe','pipe'] });
}

describe('reviewed tunnel custody composition', () => {
  it('returns no tunnel custody for a core-only reviewed runtime', async () => {
    const f = await fixture();
    let launches = 0;
    const coreOnly = parseConfig({ ...config, tunnel: { enabled: false } });
    expect(createReviewedTunnelCustody({
      configuration: coreOnly, execution: f.execution, tunnelRegistration: null, tunnelRuntime: null,
    }, () => { launches++; return child(); })).toBeNull();
    expect(launches).toBe(0);
  });

  it('refuses a mismatched runtime compatibility without launching', async () => {
    const f = await fixture(); let launches = 0;
    expect(createReviewedTunnelCustody({
      configuration: config, execution: f.execution,
      tunnelRuntime: { ...f.tunnelRuntime, compatibility: { digest: 'c'.repeat(64) } },
    }, () => { launches++; return child(); })).toBeNull();
    expect(launches).toBe(0);
  });

  it('constructs custody without acquiring a lease or launching a child', async () => {
    const f = await fixture(); let launches = 0;
    const port = createReviewedTunnelCustody({
      configuration: config, execution: f.execution, tunnelRegistration: f.tunnelRegistration, tunnelRuntime: f.tunnelRuntime,
    }, () => { launches++; return child(); });
    expect(port).not.toBeNull();
    expect(launches).toBe(0);
    expect(f.authorityCalls()).toBe(0);
    expect(await f.execution.read('tunnel')).toMatchObject({ state: 'FREE', revision: 0 });
  });

  it('uses the same durable execution store before reviewed authority and releases only after exit', async () => {
    const f = await fixture(); const plans: TunnelLaunchPlan[] = [];
    const port = createReviewedTunnelCustody({
      configuration: config, execution: f.execution, tunnelRegistration: f.tunnelRegistration, tunnelRuntime: f.tunnelRuntime,
    }, plan => { plans.push(plan); return child(); });
    if (!port) throw new Error('missing custody');
    const managed = await port.spawn(config, f.tunnelRuntime.compatibility, core, 'tg1', signal());
    expect(f.authorityCalls()).toBe(1);
    expect(plans).toEqual([{
      file: '/Library/Application Support/HAAR/GramAgent/releases/lab-tunnel/bin/tunnel-client',
      args: ['run','--config','/Library/Application Support/HAAR/GramAgent/config/tunnel-client.yaml'],
      cwd: '/Library/Application Support/HAAR/GramAgent/releases/lab-tunnel',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/Users/gram-agent' },
    }]);
    expect((await f.execution.read('tunnel')).state).toBe('HELD');
    await port.stop(managed, 20000, signal());
    await managed.exited;
    expect((await f.execution.read('tunnel')).state).toBe('FREE');
  });

  it('fails before launch when the tunnel execution record is absent', async () => {
    const f = await fixture(false); let launches = 0;
    const port = createReviewedTunnelCustody({
      configuration: config, execution: f.execution, tunnelRegistration: f.tunnelRegistration, tunnelRuntime: f.tunnelRuntime,
    }, () => { launches++; return child(); });
    if (!port) throw new Error('missing custody');
    await expect(port.spawn(config, f.tunnelRuntime.compatibility, core, 'tg1', signal()))
      .rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(launches).toBe(0); expect(f.authorityCalls()).toBe(0);
  });

  it('refuses caller compatibility different from the reviewed runtime and frees the reservation', async () => {
    const f = await fixture(); let launches = 0;
    const port = createReviewedTunnelCustody({
      configuration: config, execution: f.execution, tunnelRegistration: f.tunnelRegistration, tunnelRuntime: f.tunnelRuntime,
    }, () => { launches++; return child(); });
    if (!port) throw new Error('missing custody');
    await expect(port.spawn(config, { digest: 'c'.repeat(64) }, core, 'tg1', signal()))
      .rejects.toThrow(/^TUNNEL_START_FAILED$/);
    expect(launches).toBe(0); expect(f.authorityCalls()).toBe(0);
    expect((await f.execution.read('tunnel')).state).toBe('FREE');
  });
});
