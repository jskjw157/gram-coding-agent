import { chmod, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindReviewedCoreRuntimeAt } from './runtime-authority.js';
import type { RuntimeStores } from './runtime-stores.js';
import type { ServiceConfig } from '../contracts.js';
import { fixture, snapshot } from '../test-support/runtime/fixture.js';
const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup() {
  const f = await fixture(); roots.push(f.anchor);
  const result = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, new AbortController().signal);
  if (!result) throw new Error('runtime');
  const runtime = result as typeof result & { stores: RuntimeStores; configuration: Readonly<ServiceConfig> };
  return { f, runtime };
}
const owner = (releaseDigest: string) => ({ role: 'core' as const, generation: 'store-1', releaseDigest });
const status = (releaseDigest: string) => ({ schemaVersion: 1, ...owner(releaseDigest), state: 'STARTING', code: 'OK', observedAtMs: 10, attemptCount: 0 });
describe('reviewed circuit/status/event store composition', () => {
  it('exposes independently bound stores and immutable normalized configuration without initializing history', async () => {
    const { f, runtime } = await setup(); const before = await snapshot(f.base);
    expect(runtime.stores).toBeDefined(); expect(runtime.configuration).toEqual(f.review.config);
    expect(Object.isFrozen(runtime.configuration)).toBe(true);
    await expect(runtime.stores.lifecycle.read('core')).rejects.toThrow('MISSING_HISTORY');
    expect(await snapshot(f.base)).toEqual(before);
  });
  it('writes each existing fixed family to its pinned private run/log directory', async () => {
    const { f, runtime } = await setup(); expect(runtime.stores).toBeDefined();
    const leaseBefore = await readFile(join(f.base, 'run/core.execution.json'));
    await runtime.stores.lifecycle.initializeNew('core', 1);
    const event = status(f.review.config.releaseDigest); await runtime.stores.telemetry.writeStatus('core', event, owner(event.releaseDigest));
    const { state: _state, ...safeEvent } = event; await runtime.stores.telemetry.appendEvent('core', safeEvent);
    expect(await runtime.readCoreStatus()).toMatchObject({ state: 'STARTING', generation: 'store-1' });
    expect(await readFile(join(f.base, 'run/core.execution.json'))).toEqual(leaseBefore);
    for (const name of ['run/core.circuit.json', 'run/core.status.json', 'logs/core.events.0.jsonl']) {
      expect((await stat(join(f.base, name))).mode & 0o777).toBe(0o600);
    }
  });
  it.each(['run', 'logs'])('refuses writes if the pinned %s directory is replaced', async name => {
    const { f, runtime } = await setup(); expect(runtime.stores).toBeDefined();
    const replacement = await fixture(); roots.push(replacement.anchor);
    await rename(join(f.base, name), join(f.base, name + '-old')); await rename(join(replacement.base, name), join(f.base, name));
    const before = await snapshot(f.base);
    await expect(runtime.stores.telemetry.writeStatus('core', status(f.review.config.releaseDigest), owner(f.review.config.releaseDigest))).rejects.toThrow();
    expect(await snapshot(f.base)).toEqual(before);
  });
  it('observes persisted status across independent runtime bindings', async () => {
    const { f, runtime } = await setup(); expect(runtime.stores).toBeDefined();
    await runtime.stores.telemetry.writeStatus('core', status(f.review.config.releaseDigest), owner(f.review.config.releaseDigest));
    const other = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, new AbortController().signal);
    expect(await other?.readCoreStatus()).toMatchObject({ generation: 'store-1', state: 'STARTING' });
  });
  it('rejects private diagnostics and unsafe log permissions without changing existing files', async () => {
    const { f, runtime } = await setup(); expect(runtime.stores).toBeDefined();
    const before = await snapshot(f.base);
    await expect(runtime.stores.telemetry.appendEvent('core', { ...status(f.review.config.releaseDigest), raw: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' })).rejects.toThrow();
    expect(await snapshot(f.base)).toEqual(before);
    await chmod(join(f.base, 'logs'), 0o750);
    await expect(runtime.stores.lifecycle.read('core')).rejects.toThrow('UNSAFE_PATH');
  });
});
