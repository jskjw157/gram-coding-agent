import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bindReviewedCoreRuntimeAt } from './runtime-authority.js';
import { fixture, snapshot } from '../test-support/runtime/fixture.js';
import { child, signal } from '../test-support/runtime/discovery.js';
import { encodeStatus } from '../telemetry.js';
const roots: string[] = [];
async function setup() { const f = await fixture(); roots.push(f.anchor); return f; }
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('observation ports share the previously verified runtime directory', () => {
  it('provides missing status/registration as unavailable without creating records', async () => {
    const f = await setup(); const before = await snapshot(f.base);
    const r = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal());
    expect(r).not.toBeNull(); if (!r) throw new Error('runtime');
    expect(r.registration).toBeDefined(); expect(await r.registration.read()).toBeNull();
    expect(await r.readCoreStatus()).toBeNull(); expect(await snapshot(f.base)).toEqual(before);
  });
  it('different runtime bindings read the same producer record and status', async () => {
    const f = await setup(); const bind = () => bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal());
    const a = await bind(); const b = await bind(); if (!a || !b) throw new Error('runtime');
    expect(a.registration).toBeDefined(); expect(b.registration).toBeDefined();
    await a.execution.acquire('core', 'g1', f.review.configDigest, f.review.config.releaseDigest);
    const owner = { ...child(), uid: f.uid, releaseDigest: f.review.config.releaseDigest };
    const published = await a.registration.publish(f.review.config, owner);
    expect(await b.registration.read()).toEqual(published);
    const status = { schemaVersion: 1, role: 'core', generation: 'g1', releaseDigest: owner.releaseDigest,
      state: 'LOCAL_CORE_HEALTHY', code: 'OK', observedAtMs: 1000, attemptCount: 0 };
    await writeFile(join(f.base, 'run/core.status.json'), encodeStatus(status), { mode: 0o600 });
    expect(await b.readCoreStatus()).toEqual(status);
  });
  it('rejects discovery reads after the pinned directory is replaced', async () => {
    const f = await setup(); const replacement = await setup();
    const r = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal());
    if (!r) throw new Error('runtime'); expect(r.registration).toBeDefined();
    await rename(join(f.base, 'run'), join(f.base, 'run-old'));
    await rename(join(replacement.base, 'run'), join(f.base, 'run'));
    await expect(r.registration.read()).rejects.toThrow(); await expect(r.readCoreStatus()).rejects.toThrow();
    expect(await readFile(join(f.base, 'run/core.execution.json'), 'utf8')).toContain('"state":"FREE"');
  });
});
