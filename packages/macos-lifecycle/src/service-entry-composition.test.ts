import { EventEmitter } from 'node:events';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { root } from './contracts.js';
import { createServiceSession, createReviewedServiceSession } from './service-session.js';
import { runSupervisorEntry, type SupervisorSignals } from './supervisor-entry.js';
import { bindReviewedCoreRuntimeAt } from './adapters/runtime-authority.js';
import { fixture, snapshot } from './test-support/runtime/fixture.js';
import { decodeHistory } from './lifecycle-store.js';
const roots: string[] = [];
const argv = ['--role', 'core', '--config', `${root}/config/service.json`];
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() {
  const f = await fixture(); roots.push(f.anchor);
  const runtime = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, new AbortController().signal);
  if (!runtime) throw new Error('fixture runtime'); return { f, runtime };
}
describe('entry/session/store composition; real temporary records, controlled child, no native service', () => {
  it('constructs reviewed native ports without credential use or file mutation and respects pre-cancellation', async () => {
    const { f, runtime } = await setup(); const before = await snapshot(f.base); let uses = 0;
    const session = createReviewedServiceSession('core', runtime, { async withValue() { uses++; throw new Error('MUST_NOT_READ'); } });
    expect(await snapshot(f.base)).toEqual(before);
    const cancelled = new AbortController(); cancelled.abort(); expect(await session.run(cancelled.signal)).toBe(0);
    expect(uses).toBe(0); expect(await snapshot(f.base)).toEqual(before);
  });
  it('uses real clock/UUID defaults and waits for controlled child shutdown before final persisted STOPPED', async () => {
    const { f, runtime } = await setup(); const events = new EventEmitter(); const actions: string[] = [];
    await runtime.stores.lifecycle.initializeNew('core', Date.now());
    const stopping = deferred<undefined>(); const allowExit = deferred<undefined>(); let finish: () => void = () => {};
    const writeStatus = runtime.stores.telemetry.writeStatus.bind(runtime.stores.telemetry);
    runtime.stores.telemetry.writeStatus = async (role, value, identity) => {
      await writeStatus(role, value, identity);
      if (value !== null && typeof value === 'object' && 'state' in value && value.state === 'LOCAL_CORE_HEALTHY') events.emit('SIGTERM');
    };
    const session = createServiceSession('core', runtime.configuration, {
      stores: runtime.stores,
      core: {
        async spawn(config, generation) {
          actions.push('spawn'); expect(generation).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
          expect((await runtime.stores.lifecycle.read('core')).history.activeAttempt?.generation).toBe(generation);
          return { child: { role: 'core', uid: f.uid, pid: 6543, startIdentity: '1700000000.9', generation, releaseDigest: config.releaseDigest },
            exited: new Promise<void>(resolve => { finish = resolve; }) };
        },
        async probe(child) { actions.push('probe'); return { state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: child.generation,
          releaseDigest: child.releaseDigest, observedAtMs: Date.now() }; },
        async stop(child) { expect(child.child.pid).toBe(6543); actions.push('stop'); stopping.resolve(undefined); await allowExit.promise; finish(); },
      },
      async currentCore() { throw new Error('CORE_ROLE_MUST_NOT_DISCOVER'); },
    });
    let complete = false;
    const work = runSupervisorEntry(argv, { async prepare() { return session; } }, events);
    void work.then(() => { complete = true; }, () => { complete = true; });
    await Promise.race([stopping.promise, work.then(() => { throw new Error('STOP_NOT_REACHED'); })]);
    expect(complete).toBe(false);
    try { expect(JSON.parse(await readFile(join(f.base, 'run/core.status.json'), 'utf8')).state).toBe('STOPPING'); }
    finally { allowExit.resolve(undefined); }
    expect(await work).toBe(0); expect(actions).toEqual(['spawn', 'probe', 'stop']);
    expect(decodeHistory(await readFile(join(f.base, 'run/core.circuit.json'))).activeAttempt).toBeNull();
    expect(JSON.parse(await readFile(join(f.base, 'run/core.status.json'), 'utf8')).state).toBe('STOPPED');
    expect(events.eventNames()).toEqual([]);
  });
  it('cleans partial signal registration on hook failure without preparing or starting anything', async () => {
    const events = new EventEmitter(); let prepared = 0;
    const signals: SupervisorSignals = {
      on(event, listener) { events.on(event, listener); if (event === 'SIGTERM') throw new Error('PRIVATE_SIGNAL_FAILURE'); },
      removeListener(event, listener) { events.removeListener(event, listener); },
    };
    expect(await runSupervisorEntry(argv, { async prepare() { prepared++; return null; } }, signals)).toBe(70);
    expect(prepared).toBe(0); expect(events.eventNames()).toEqual([]);
  });
});
