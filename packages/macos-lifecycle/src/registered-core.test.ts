import { describe, expect, it } from 'vitest';
import { configDigest } from './config.js';
import { withRegisteredCore } from './registered-core.js';
import type { SupervisorDeps, ManagedChild } from './supervisor.js';
import { child, config, deferred, signal } from './test-support/runtime/discovery.js';
function fixture() {
  const exit = deferred(); const managed: ManagedChild = { child: child(), exited: exit.promise };
  const calls: string[] = [];
  const core: SupervisorDeps['core'] = {
    async spawn() { calls.push('spawn'); return managed; },
    async probe() { calls.push('probe'); return { state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: 'g1', releaseDigest: child().releaseDigest, observedAtMs: 0 }; },
    async stop(given) { expect(given).toBe(managed); calls.push('stop'); exit.resolve(); },
  };
  return { exit, managed, calls, core };
}
describe('Core identity publication before exposing a managed start', () => {
  it('publishes the exact managed child before returning and delegates stop using the original handle', async () => {
    const f = fixture();
    const wrapped = withRegisteredCore(f.core, { async publish(c, owner) { expect(c).toEqual(config()); expect(owner).toEqual(child()); f.calls.push('publish');
      return { schemaVersion: 1, role: 'core', configDigest: configDigest(c), executionRevision: 1,
        executionToken: '11111111-1111-4111-8111-111111111111', child: owner }; } });
    const managed = await wrapped.spawn(config(), 'g1', signal()); expect(f.calls).toEqual(['spawn', 'publish']);
    await wrapped.stop(managed, 20000, signal()); await managed.exited; expect(f.calls).toEqual(['spawn', 'publish', 'stop']);
  });
  it('a publication failure stops and confirms the child rather than leaving an untracked rejected start', async () => {
    const f = fixture(); const wrapped = withRegisteredCore(f.core, { async publish() { throw new Error('SYNTHETIC_PATH'); } });
    await expect(wrapped.spawn(config(), 'g1', signal())).rejects.toThrow('CORE_START_FAILED');
    expect(f.calls).toEqual(['spawn', 'stop']);
  });
  it('an uncertain cleanup leaves startup unresolved and blocks another start until actual exit', async () => {
    const f = fixture(); f.core.stop = async () => { f.calls.push('stop'); throw new Error('unknown'); };
    const wrapped = withRegisteredCore(f.core, { async publish() { throw new Error('io'); } });
    let settled = false; const pending = wrapped.spawn(config(), 'g1', signal()).then(() => { settled = true; }, () => { settled = true; });
    await new Promise<void>(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    await expect(wrapped.spawn(config(), 'g2', signal())).rejects.toThrow('CORE_START_FAILED');
    f.exit.resolve(); await pending; expect(settled).toBe(true);
  });
  it('does not publish or delegate if already cancelled', async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    const wrapped = withRegisteredCore(f.core, { async publish() { throw new Error('must not run'); } });
    await expect(wrapped.spawn(config(), 'g1', abort.signal)).rejects.toThrow('CORE_START_FAILED'); expect(f.calls).toEqual([]);
  });
});
