import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { configDigest } from '../config.js';
import type { AccountIdentity, OwnedChild } from '../contracts.js';
import type { CoreEvidence } from '../health-probe.js';
import type { ManagedChild, TunnelCompatibility } from '../supervisor.js';
import type { ExecutableIdentity, NativePeerProofPort } from './owned-process.js';
import { createNativeTunnelCustody, tunnelLaunchPlan } from './native-tunnel.js';

const release = 'a'.repeat(64);
const compatibilityDigest = 'b'.repeat(64);
const config = {
  schemaVersion: 1 as const, mode: 'LAB_ONLY' as const, runtimeUser: 'gram-agent' as const,
  releaseId: 'lab-tunnel', releaseDigest: release,
  tunnel: { enabled: true as const, compatibilityDigest, credentialRef: 'test-tunnel-key' as const },
};
const compatibility: TunnelCompatibility = Object.freeze({ digest: compatibilityDigest });
const core: CoreEvidence = Object.freeze({
  state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: 'core-g1', releaseDigest: release, observedAtMs: 10,
});
const account: AccountIdentity = Object.freeze({
  name: 'gram-agent', uid: process.getuid?.() ?? 501, gid: process.getgid?.() ?? 20, admin: false,
});
const executable: ExecutableIdentity = Object.freeze({ dev: 11n, ino: 22n });
function proof(): NativePeerProofPort {
  return Object.freeze({
    async capture() { return { sec: '1700000000', usec: '9' }; },
    async current() { return 'OWNED'; },
    async peer() { return 'UNKNOWN'; },
  });
}
function fixtureChild(): ChildProcess {
  return spawn(process.execPath, ['-e',
    "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),10));setInterval(()=>{},1000);"
  ], { stdio: ['ignore','pipe','pipe'] });
}
function same(a: OwnedChild, b: OwnedChild) {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe('native tunnel child custody', () => {
  it('launches only after reviewed authority and returns a sealed tunnel identity', async () => {
    const plans: unknown[] = []; let acquired = 0;
    const port = createNativeTunnelCustody({
      authority: {
        async acquire(input, comp, evidence) {
          acquired++;
          expect(configDigest(input)).toBe(configDigest(config));
          expect(comp).toEqual(compatibility);
          expect(evidence).toEqual(core);
          return { configDigest: configDigest(config), compatibilityDigest, account, executable, proof: proof() };
        },
      },
      launch(plan) { plans.push(plan); return fixtureChild(); },
    });
    const managed = await port.spawn(config, compatibility, core, 'tunnel-g1', new AbortController().signal);
    expect(acquired).toBe(1);
    expect(plans).toEqual([tunnelLaunchPlan(config)]);
    expect(managed.child.role).toBe('tunnel');
    expect(managed.child.generation).toBe('tunnel-g1');
    expect(managed.child.releaseDigest).toBe(release);
    await port.stop(managed, 20000, new AbortController().signal);
    await expect(managed.exited).resolves.toBeUndefined();
  });

  it('rejects wrong compatibility before launch', async () => {
    let launches = 0; let acquireCalls = 0;
    const port = createNativeTunnelCustody({
      authority: { async acquire() { acquireCalls++; return null; } },
      launch() { launches++; return fixtureChild(); },
    });
    await expect(port.spawn(config, { digest: 'c'.repeat(64) }, core, 'g1', new AbortController().signal))
      .rejects.toThrow('TUNNEL_START_FAILED');
    expect(acquireCalls).toBe(0); expect(launches).toBe(0);
  });

  it('rejects an authority grant for another executable or configuration', async () => {
    let launches = 0;
    const port = createNativeTunnelCustody({
      authority: {
        async acquire() {
          return { configDigest: 'c'.repeat(64), compatibilityDigest, account, executable, proof: proof() };
        },
      },
      launch() { launches++; return fixtureChild(); },
    });
    await expect(port.spawn(config, compatibility, core, 'g1', new AbortController().signal))
      .rejects.toThrow('TUNNEL_START_FAILED');
    expect(launches).toBe(0);
  });

  it('allows only one start attempt per custody instance', async () => {
    const port = createNativeTunnelCustody({
      authority: { async acquire() {
        return { configDigest: configDigest(config), compatibilityDigest, account, executable, proof: proof() };
      } },
      launch() { return fixtureChild(); },
    });
    const first = await port.spawn(config, compatibility, core, 'g1', new AbortController().signal);
    await expect(port.spawn(config, compatibility, core, 'g2', new AbortController().signal))
      .rejects.toThrow('TUNNEL_START_FAILED');
    await port.stop(first, 20000, new AbortController().signal);
  });

  it('refuses stop requests for a copied or foreign managed child', async () => {
    const port = createNativeTunnelCustody({
      authority: { async acquire() {
        return { configDigest: configDigest(config), compatibilityDigest, account, executable, proof: proof() };
      } },
      launch() { return fixtureChild(); },
    });
    const managed = await port.spawn(config, compatibility, core, 'g1', new AbortController().signal);
    const copied: ManagedChild = { child: { ...managed.child }, exited: managed.exited };
    expect(same(copied.child, managed.child)).toBe(true);
    await expect(port.stop(copied, 20000, new AbortController().signal))
      .rejects.toThrow('TUNNEL_STOP_UNKNOWN');
    await port.stop(managed, 20000, new AbortController().signal);
  });

  it('does not treat a delivered signal as confirmed exit', async () => {
    let child: ChildProcess | null = null;
    const port = createNativeTunnelCustody({
      authority: { async acquire() {
        return { configDigest: configDigest(config), compatibilityDigest, account, executable, proof: proof() };
      } },
      launch() {
        child = spawn(process.execPath, ['-e',
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);"
        ], { stdio: ['ignore','pipe','pipe'] });
        return child;
      },
    });
    const managed = await port.spawn(config, compatibility, core, 'g1', new AbortController().signal);
    await port.stop(managed, 2000, new AbortController().signal);
    await expect(managed.exited).resolves.toBeUndefined();
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  }, 5000);
});
