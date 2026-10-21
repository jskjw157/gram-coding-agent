import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createServiceSession, type ServiceSessionDeps } from './service-session.js';
import { LifecycleStore, decodeHistory } from './lifecycle-store.js';
import { TelemetryStore } from './telemetry-store.js';
import { createCircuitFilesAt } from './adapters/service-files.js';
import { createTelemetryFilesAt } from './adapters/telemetry-files.js';
import { fixture, snapshot } from './test-support/runtime/fixture.js';
import type { ManagedChild } from './supervisor.js';
import type { Role } from './contracts.js';
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup(initialize = true) {
  const f = await fixture(); roots.push(f.anchor);
  const lifecycle = new LifecycleStore(createCircuitFilesAt(f.runPolicy));
  const files = createTelemetryFilesAt(f.runPolicy, { ...f.runPolicy, relative: f.layout.relative + '/logs' });
  const telemetry = new TelemetryStore(files.status, files.events);
  if (initialize) await lifecycle.initializeNew('core', 1);
  const controller = new AbortController(); const actions: string[] = []; let finish: () => void = () => {};
  const deps: ServiceSessionDeps = {
    stores: { lifecycle, telemetry }, clock: { nowMs: () => 1000, async sleep() { controller.abort(); } }, nextGeneration: () => 'session-1',
    core: {
      async spawn(config, generation) {
        actions.push('spawn'); expect((await lifecycle.read('core')).history.activeAttempt?.generation).toBe(generation);
        return { child: { role: 'core', pid: 5010, uid: f.uid, generation, releaseDigest: config.releaseDigest,
          startIdentity: '1700000000.1' }, exited: new Promise<void>(resolve => { finish = resolve; }) };
      },
      async probe(child) { actions.push('probe'); return { state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: child.generation,
        releaseDigest: child.releaseDigest, observedAtMs: 1000 }; },
      async stop(child: ManagedChild) { expect(child.child.role).toBe('core'); actions.push('stop'); finish(); },
    },
    async currentCore() { actions.push('currentCore'); return null; },
  };
  return { f, deps, controller, actions, lifecycle };
}
describe('single-use service session with real file stores and controlled child ports', () => {
  it('constructs without file changes and persists begin/healthy/intentional stop through existing stores', async () => {
    const t = await setup(); const before = await snapshot(t.f.base);
    const session = createServiceSession('core', t.f.review.config, t.deps);
    expect(await snapshot(t.f.base)).toEqual(before); expect(t.actions).toEqual([]);
    expect(await session.run(t.controller.signal)).toBe(0); expect(t.actions).toEqual(['spawn', 'probe', 'stop']);
    const history = decodeHistory(await readFile(join(t.f.base, 'run/core.circuit.json')));
    expect(history.activeAttempt).toBeNull(); expect(history.exitsMs).toEqual([]);
    const status = JSON.parse(await readFile(join(t.f.base, 'run/core.status.json'), 'utf8'));
    expect(status).toMatchObject({ state: 'STOPPED', generation: 'session-1', code: 'OK' });
    expect(await readFile(join(t.f.base, 'logs/core.events.0.jsonl'), 'utf8')).toContain('session-1');
  });
  it('does not create missing history to make startup work', async () => {
    const t = await setup(false); const session = createServiceSession('core', t.f.review.config, t.deps);
    expect(await session.run(t.controller.signal)).toBe(0); expect(t.actions).toEqual([]);
    await expect(t.lifecycle.read('core')).rejects.toThrow('MISSING_HISTORY');
    expect(JSON.parse(await readFile(join(t.f.base, 'run/core.status.json'), 'utf8')).state).toBe('BLOCKED_CONFIGURATION');
  });
  it('keeps an unresolved active attempt without fabricated stopped proof', async () => {
    const t = await setup(); await t.lifecycle.write('core', await t.lifecycle.read('core'), { kind: 'begin', generation: 'old', nowMs: 10 });
    const before = await readFile(join(t.f.base, 'run/core.circuit.json'));
    expect(await createServiceSession('core', t.f.review.config, t.deps).run(t.controller.signal)).toBe(0);
    expect(t.actions).toEqual([]); expect(await readFile(join(t.f.base, 'run/core.circuit.json'))).toEqual(before);
  });
  it('does not run a session twice, including after cancellation', async () => {
    const t = await setup(); const session = createServiceSession('core', t.f.review.config, t.deps); t.controller.abort();
    const before = await snapshot(t.f.base); expect(await session.run(t.controller.signal)).toBe(0);
    await expect(session.run(new AbortController().signal)).rejects.toThrow('SESSION_ALREADY_USED');
    expect(await snapshot(t.f.base)).toEqual(before);
  });
  it('copies configuration and method bindings before caller mutation', async () => {
    const t = await setup(); const session = createServiceSession('core', t.f.review.config, t.deps);
    t.f.review.config.releaseDigest = 'b'.repeat(64); t.deps.core.spawn = async () => { throw new Error('REPLACED'); };
    expect(await session.run(t.controller.signal)).toBe(0); expect(t.actions).toEqual(['spawn', 'probe', 'stop']);
  });
  it('does nothing for a disabled tunnel role', async () => {
    const t = await setup(); const before = await snapshot(t.f.base);
    expect(await createServiceSession('tunnel', t.f.review.config, t.deps).run(t.controller.signal)).toBe(0);
    expect(t.actions).toEqual([]); expect(await snapshot(t.f.base)).toEqual(before);
  });
  it('refuses enabled tunnel composition without a verified transport port', async () => {
    const t = await setup(); const before = await snapshot(t.f.base);
    const enabled = { ...t.f.review.config, tunnel: { enabled: true as const, compatibilityDigest: 'c'.repeat(64), credentialRef: 'test-tunnel-key' as const } };
    expect(() => createServiceSession('tunnel', enabled, t.deps)).toThrow('TUNNEL_COMPATIBILITY_REQUIRED');
    expect(t.actions).toEqual([]); expect(await snapshot(t.f.base)).toEqual(before);
  });
  it('rejects unknown role before touching files', async () => {
    const t = await setup(); const before = await snapshot(t.f.base);
    expect(() => createServiceSession('other' as Role, t.f.review.config, t.deps)).toThrow('INVALID_CONFIG');
    expect(await snapshot(t.f.base)).toEqual(before);
  });
});
