import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createAReviewedSupervisorBootstrap, createASystemReviewedSupervisorBootstrap } from './a-bootstrap.js';
import { encodeRuntimeReview } from './runtime-review.js';
import { root } from './contracts.js';
import { fixture } from './test-support/runtime/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('A/WP-06 reviewed supervisor bootstrap composition', () => {
  it('binds a reviewed runtime from independently supplied approval/candidate ports', async () => {
    const f = await fixture();
    roots.push(f.anchor);
    const bytes = encodeRuntimeReview(f.review);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    let approvalReads = 0;
    let candidateReads = 0;
    let credentialUses = 0;

    const bootstrap = createAReviewedSupervisorBootstrap({
      layout: f.layout,
      acl: f.acl,
      environment: f.environment,
      approval: {
        expectedDigest: async () => {
          approvalReads += 1;
          return expectedDigest;
        },
      },
      candidate: {
        read: async () => {
          candidateReads += 1;
          return Buffer.from(bytes);
        },
      },
      credentials: {
        async withValue<T>(use: (secret: string) => Promise<T>): Promise<T> {
          credentialUses += 1;
          return use('SYNTHETIC_TEST_SECRET');
        },
      },
    });

    const session = await bootstrap.prepare(
      {
        role: 'core',
        configPath: `${root}/config/service.json`,
      },
      new AbortController().signal,
    );

    expect(session).not.toBeNull();
    expect(approvalReads).toBe(1);
    expect(candidateReads).toBe(1);
    expect(credentialUses).toBe(0);
  });


  it('system composition cannot be redirected to a fixture layout or CI account', async () => {
    const f = await fixture();
    roots.push(f.anchor);
    const bytes = encodeRuntimeReview(f.review);
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    const bootstrap = createASystemReviewedSupervisorBootstrap({
      acl: f.acl,
      approval: { expectedDigest: async () => expectedDigest },
      candidate: { read: async () => Buffer.from(bytes) },
      credentials: {
        async withValue<T>(use: (secret: string) => Promise<T>): Promise<T> {
          return use('SYNTHETIC_TEST_SECRET');
        },
      },
    });

    expect(await bootstrap.prepare(
      { role: 'core', configPath: `${root}/config/service.json` },
      new AbortController().signal,
    )).toBeNull();
  });

  it('fails closed when the independent approval digest does not match candidate bytes', async () => {
    const f = await fixture();
    roots.push(f.anchor);
    const bytes = encodeRuntimeReview(f.review);
    const bootstrap = createAReviewedSupervisorBootstrap({
      layout: f.layout,
      acl: f.acl,
      environment: f.environment,
      approval: { expectedDigest: async () => 'f'.repeat(64) },
      candidate: { read: async () => Buffer.from(bytes) },
      credentials: {
        async withValue<T>(use: (secret: string) => Promise<T>): Promise<T> {
          return use('SYNTHETIC_TEST_SECRET');
        },
      },
    });

    expect(await bootstrap.prepare(
      { role: 'core', configPath: `${root}/config/service.json` },
      new AbortController().signal,
    )).toBeNull();
  });
});
