import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { configDigest } from './config.js';
import { root } from './contracts.js';
import type { CoreCredentials } from './health-probe.js';
import { encodeRuntimeReview } from './runtime-review.js';
import { createReviewedBootstrap } from './reviewed-bootstrap.js';
import { bindReviewedCoreRuntimeAt } from './adapters/runtime-authority.js';
import { fixture } from './test-support/runtime/fixture.js';

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  while (roots.length) {
    const path = roots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});
async function setup() {
  const f = await fixture(); roots.push(f.anchor);
  const bytes = encodeRuntimeReview(f.review);
  let credentialsUsed = 0; let binds = 0; let candidateReads = 0; let approvalReads = 0;
  const credentials: CoreCredentials = Object.freeze({
    async withValue<T>(_use: (secret: string) => Promise<T>): Promise<T> {
      credentialsUsed++; throw new Error('CREDENTIAL_USE_DURING_PREPARE');
    },
  });
  const bootstrap = createReviewedBootstrap({
    approval: Object.freeze({ async expectedDigest() { approvalReads++; return sha(bytes); } }),
    candidate: Object.freeze({ async read() { candidateReads++; return Buffer.from(bytes); } }),
    async bind(review, signal) {
      binds++;
      return bindReviewedCoreRuntimeAt(f.layout, review, f.acl, f.environment, signal);
    },
    credentials,
  });
  return { f, bytes, bootstrap, stats: () => ({ credentialsUsed, binds, candidateReads, approvalReads }) };
}
const invocation = (role: 'core' | 'tunnel' = 'core') =>
  Object.freeze({ role, configPath: `${root}/config/service.json` });

describe('reviewed bootstrap admission', () => {
  it('prepares a session only from bytes matching an independently supplied digest', async () => {
    const s = await setup();
    const session = await s.bootstrap.prepare(invocation(), new AbortController().signal);
    expect(session).not.toBeNull();
    expect(s.stats()).toEqual({ credentialsUsed: 0, binds: 1, candidateReads: 1, approvalReads: 1 });
  });

  it('does not read candidate bytes when independent approval is unavailable', async () => {
    const s = await setup();
    const bootstrap = createReviewedBootstrap({
      approval: { async expectedDigest() { return null; } },
      candidate: { async read() { throw new Error('candidate must not be read'); } },
      bind: async () => { throw new Error('bind must not run'); },
      credentials: { async withValue<T>(): Promise<T> { throw new Error('credential must not run'); } },
    });
    await expect(bootstrap.prepare(invocation(), new AbortController().signal)).resolves.toBeNull();
    expect(s.stats().credentialsUsed).toBe(0);
  });

  it('refuses a replaced candidate without binding or using credentials', async () => {
    const s = await setup(); const expected = sha(s.bytes);
    const changed = { ...s.f.review, nodeDigest: 'f'.repeat(64) };
    const replacement = encodeRuntimeReview(changed);
    const bootstrap = createReviewedBootstrap({
      approval: { async expectedDigest() { return expected; } },
      candidate: { async read() { return replacement; } },
      bind: async () => { throw new Error('bind must not run'); },
      credentials: { async withValue<T>(): Promise<T> { throw new Error('credential must not run'); } },
    });
    await expect(bootstrap.prepare(invocation(), new AbortController().signal)).resolves.toBeNull();
  });

  it('copies candidate bytes before a later caller mutation', async () => {
    const s = await setup(); const supplied = Buffer.from(s.bytes);
    const bootstrap = createReviewedBootstrap({
      approval: { async expectedDigest() { return sha(s.bytes); } },
      candidate: { async read() { setTimeout(() => supplied.fill(0), 0); return supplied; } },
      bind: async (review, signal) => bindReviewedCoreRuntimeAt(s.f.layout, review, s.f.acl, s.f.environment, signal),
      credentials: { async withValue<T>(): Promise<T> { throw new Error('credential must not run'); } },
    });
    const session = await bootstrap.prepare(invocation(), new AbortController().signal);
    expect(session).not.toBeNull();
  });

  it('cancels a late candidate and never binds after abort', async () => {
    const s = await setup(); let resolve!: (value: Buffer) => void; let binds = 0;
    const pending = new Promise<Buffer>(r => { resolve = r; });
    const bootstrap = createReviewedBootstrap({
      approval: { async expectedDigest() { return sha(s.bytes); } },
      candidate: { async read() { return pending; } },
      bind: async () => { binds++; throw new Error('late bind'); },
      credentials: { async withValue<T>(): Promise<T> { throw new Error('credential must not run'); } },
    });
    const controller = new AbortController();
    const preparing = bootstrap.prepare(invocation(), controller.signal);
    controller.abort(); resolve(Buffer.from(s.bytes));
    await expect(preparing).resolves.toBeNull(); expect(binds).toBe(0);
  });

  it('rejects forged direct invocations before consulting trust providers', async () => {
    let reads = 0;
    const bootstrap = createReviewedBootstrap({
      approval: { async expectedDigest() { reads++; return 'a'.repeat(64); } },
      candidate: { async read() { reads++; return Buffer.alloc(1); } },
      bind: async () => null,
      credentials: { async withValue<T>(): Promise<T> { throw new Error('credential must not run'); } },
    });
    await expect(bootstrap.prepare({ role: 'core', configPath: '/tmp/service.json' }, new AbortController().signal))
      .resolves.toBeNull();
    expect(reads).toBe(0);
  });

  it('requires the bound runtime configuration to match the admitted review', async () => {
    const s = await setup(); let called = 0;
    const bootstrap = createReviewedBootstrap({
      approval: { async expectedDigest() { return sha(s.bytes); } },
      candidate: { async read() { return Buffer.from(s.bytes); } },
      bind: async (review, signal) => {
        const runtime = await bindReviewedCoreRuntimeAt(s.f.layout, review, s.f.acl, s.f.environment, signal);
        if (!runtime) return null;
        return Object.freeze({ ...runtime, configuration: { ...runtime.configuration, releaseId: 'other' } });
      },
      credentials: { async withValue<T>(): Promise<T> { called++; throw new Error('credential must not run'); } },
    });
    await expect(bootstrap.prepare(invocation(), new AbortController().signal)).resolves.toBeNull();
    expect(called).toBe(0);
  });
});
