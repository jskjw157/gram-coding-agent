import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { root } from './contracts.js';
import type { CoreCredentials } from './health-probe.js';
import { encodeRuntimeReview } from './runtime-review.js';
import { createReviewedBootstrap } from './reviewed-bootstrap.js';
import type { SupervisorBootstrap } from './supervisor-entry.js';
import type { ReviewedTunnelProvider } from './tunnel-supervisor-runtime.js';
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

interface TunnelBootstrapOptions {
  approval: { expectedDigest(signal: AbortSignal): Promise<string | null> };
  candidate: { read(signal: AbortSignal): Promise<Buffer | null> };
  bind(review: unknown, signal: AbortSignal): Promise<unknown>;
  credentials: CoreCredentials;
  tunnelProvider?: ReviewedTunnelProvider;
}
const makeBootstrap = createReviewedBootstrap as unknown as (options: TunnelBootstrapOptions) => SupervisorBootstrap;
const invocation = (role: 'core' | 'tunnel') =>
  Object.freeze({ role, configPath: `${root}/config/service.json` });

async function setup() {
  const f = await fixture({ tunnel: true }); roots.push(f.anchor);
  const bytes = encodeRuntimeReview(f.review);
  let credentialCalls = 0; let launches = 0; let probes = 0;
  const provider: ReviewedTunnelProvider = {
    async credentialAvailable() { credentialCalls++; return true; },
    launch() { launches++; throw new Error('LAUNCH_DURING_PREPARE'); },
    async probe() { probes++; return 'READY'; },
  };
  const credentials: CoreCredentials = Object.freeze({
    async withValue<T>(): Promise<T> { throw new Error('CORE_CREDENTIAL_USE_DURING_PREPARE'); },
  });
  const base = {
    approval: Object.freeze({ async expectedDigest() { return sha(bytes); } }),
    candidate: Object.freeze({ async read() { return Buffer.from(bytes); } }),
    async bind(review: unknown, signal: AbortSignal) {
      return bindReviewedCoreRuntimeAt(f.layout, review as typeof f.review, f.acl, f.environment, signal);
    },
    credentials,
  };
  return { f, base, provider, stats: () => ({ credentialCalls, launches, probes }) };
}

describe('reviewed bootstrap tunnel composition', () => {
  it('requires a trusted tunnel provider before preparing the tunnel service', async () => {
    const s = await setup();
    const bootstrap = makeBootstrap(s.base);
    await expect(bootstrap.prepare(invocation('tunnel'), new AbortController().signal)).resolves.toBeNull();
    expect(s.stats()).toEqual({ credentialCalls: 0, launches: 0, probes: 0 });
  });

  it('prepares the tunnel session with a trusted provider without using it during bootstrap', async () => {
    const s = await setup();
    const bootstrap = makeBootstrap({ ...s.base, tunnelProvider: s.provider });
    const session = await bootstrap.prepare(invocation('tunnel'), new AbortController().signal);
    expect(session).not.toBeNull();
    expect(s.stats()).toEqual({ credentialCalls: 0, launches: 0, probes: 0 });
  });

  it('does not consult the tunnel provider while preparing the core service', async () => {
    const s = await setup();
    const provider: ReviewedTunnelProvider = {
      async credentialAvailable() { throw new Error('PROVIDER_USED_FOR_CORE'); },
      launch() { throw new Error('PROVIDER_USED_FOR_CORE'); },
      async probe() { throw new Error('PROVIDER_USED_FOR_CORE'); },
    };
    const bootstrap = makeBootstrap({ ...s.base, tunnelProvider: provider });
    const session = await bootstrap.prepare(invocation('core'), new AbortController().signal);
    expect(session).not.toBeNull();
  });
});
