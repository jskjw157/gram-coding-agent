import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createReviewedCorePorts } from './core-runtime.js';
import { bindReviewedCoreRuntimeAt } from './adapters/runtime-authority.js';
import { fixture, snapshot } from './test-support/runtime/fixture.js';
import { child, signal } from './test-support/runtime/discovery.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('reviewed Core composition before any installed launch', () => {
  it('constructs both ports without spawning, acquiring a slot or reading credentials', async () => {
    const f = await fixture(); roots.push(f.anchor);
    const runtime = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, signal()); if (!runtime) throw new Error('runtime');
    const before = await snapshot(f.base); let secrets = 0;
    const ports = createReviewedCorePorts(f.review.config, runtime, { async withValue(use) { secrets++; return use('SYNTHETIC'); } });
    expect(typeof ports.core.spawn).toBe('function'); expect(typeof ports.currentCore).toBe('function');
    expect(await ports.currentCore(signal())).toBeNull(); expect(await snapshot(f.base)).toEqual(before); expect(secrets).toBe(0);
    expect((await ports.core.probe(child(), signal())).state).toBe('UNKNOWN');
    await expect(ports.core.stop({ child: child(), exited: Promise.resolve() }, 20000, signal())).rejects.toThrow('CORE_STOP_UNKNOWN');
    expect(secrets).toBe(0);
  });
});
