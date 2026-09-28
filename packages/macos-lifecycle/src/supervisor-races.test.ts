import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ManagedChild, SupervisorDeps } from './supervisor.js';
import { runSupervisor } from './supervisor.js';
import { fixture, labConfig, managed } from './test-support/supervisor-fixture.js';
afterEach(() => vi.useRealTimers());
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve };
}
describe('supervisor trust boundaries and cancellation', () => {
  it('does not let a compatibility provider rewrite the reviewed configuration', async () => {
    const f = await fixture();
    f.deps.tunnel.compatibility = async config => {
      Reflect.set(config.tunnel, 'compatibilityDigest', 'c'.repeat(64));
      return { digest: 'c'.repeat(64) };
    };
    expect(await runSupervisor('tunnel', labConfig(true), f.deps, f.controller.signal)).toBe(0);
    expect(f.trace).not.toContain('credential'); expect(f.trace).not.toContain('spawn:tunnel');
  });
  it('requires literal true for credential availability, not an unknown truthy response', async () => {
    const f = await fixture(); f.deps.tunnel.credentialAvailable = async () => 'UNKNOWN' as unknown as boolean;
    await runSupervisor('tunnel', labConfig(true), f.deps, f.controller.signal);
    expect(f.trace).not.toContain('spawn:tunnel');
  });
  it('requires literal true for stopped-owner evidence before recovering an active marker', async () => {
    const f = await fixture();
    await f.deps.lifecycle.write('core', await f.deps.lifecycle.read('core'), { kind: 'begin', generation: 'old', nowMs: 0 });
    (f.deps as SupervisorDeps & { confirmStopped: () => Promise<boolean> }).confirmStopped = async () => 'UNKNOWN' as unknown as boolean;
    await runSupervisor('core', labConfig(), f.deps, f.controller.signal);
    expect(f.trace).not.toContain('spawn:core');
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt?.generation).toBe('old');
  });
  it('rechecks core after asynchronous compatibility before consulting credentials', async () => {
    const f = await fixture(); let alive = true;
    f.deps.currentCore = async () => alive ? f.evidence() : null;
    f.deps.tunnel.compatibility = async () => { alive = false; return { digest: 'b'.repeat(64) }; };
    await runSupervisor('tunnel', labConfig(true), f.deps, f.controller.signal);
    expect(f.trace).not.toContain('credential'); expect(f.trace).not.toContain('spawn:tunnel');
  });
  it('cancels a hung health probe and still stops the owned child', async () => {
    const f = await fixture(); const entered = deferred<void>();
    f.deps.core.probe = async () => { entered.resolve(); return new Promise(() => {}); };
    const pending = runSupervisor('core', labConfig(), f.deps, f.controller.signal);
    await entered.promise; f.controller.abort();
    expect(await pending).toBe(0); expect(f.trace).toContain('stop:core:20000:false');
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt).toBeNull();
  });
  it('preserves an uncertain spawn marker and cleans up a child arriving after cancellation', async () => {
    const f = await fixture(); const entered = deferred<string>(); const late = deferred<ManagedChild>();
    f.deps.core.spawn = async (_config, generation) => { entered.resolve(generation); return late.promise; };
    const pending = runSupervisor('core', labConfig(), f.deps, f.controller.signal);
    const generation = await entered.promise; f.controller.abort();
    expect(await pending).toBe(1);
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt?.generation).toBe(generation);
    late.resolve(managed('core', generation)); await new Promise<void>(done => setImmediate(done));
    expect(f.trace).toContain('stop:core:20000:false');
    // Late cleanup cannot authorize recovery/reset of this durable marker.
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt?.generation).toBe(generation);
  });
  it('refuses a foreign returned child without sending a stop to an unowned identity', async () => {
    const f = await fixture(); f.deps.core.spawn = async () => managed('core', 'not-requested');
    expect(await runSupervisor('core', labConfig(), f.deps, f.controller.signal)).toBe(1);
    expect(f.trace.some(x => x.startsWith('stop:'))).toBe(false);
    expect((await f.deps.lifecycle.read('core')).history.activeAttempt).not.toBeNull();
  });
  it('does not spawn after the durable begin write is refused', async () => {
    const f = await fixture(); f.circuit.compareAndSwap = async () => { throw new Error('STATE_CONFLICT'); };
    expect(await runSupervisor('core', labConfig(), f.deps, f.controller.signal)).toBe(1);
    expect(f.trace).not.toContain('spawn:core');
  });
  it('does not clear the crash budget after its fifth failed start', async () => {
    const f = await fixture();
    f.deps.core.spawn = async () => { throw new Error('synthetic spawn error'); };
    for (let i = 0; i < 4; i++) expect(await runSupervisor('core', labConfig(), f.deps, f.controller.signal)).toBe(1);
    expect(await runSupervisor('core', labConfig(), f.deps, f.controller.signal)).toBe(0);
    const h = (await f.deps.lifecycle.read('core')).history;
    expect(h.blocked).toBe(true); expect(h.exitsMs).toHaveLength(5);
  });
});
