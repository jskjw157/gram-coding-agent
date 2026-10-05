import { createHash } from 'node:crypto';
import { chmod, rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createBootstrapFileSources, createSystemBootstrapSources, systemBootstrapPaths } from './a-system-sources.js';
import { encodeRuntimeReview } from './runtime-review.js';
import { fixture } from './test-support/runtime/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('A fixed bootstrap trust sources', () => {
  it('reads separate approved digest and candidate bytes and uses the core secret only inside the callback', async () => {
    const f = await fixture();
    roots.push(f.anchor);
    const review = encodeRuntimeReview(f.review);
    const digest = createHash('sha256').update(review).digest('hex');
    await writeFile(`${f.base}/config/runtime-review.json`, review, { mode: 0o600 });
    await writeFile(`${f.base}/config/runtime-review.sha256`, `${digest}\n`, { mode: 0o600 });
    await writeFile(`${f.base}/secrets/mcp-internal-secret`, 'SYNTHETIC_CORE_SECRET\n', { mode: 0o600 });

    const sources = createBootstrapFileSources({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      acl: f.acl,
    });
    const signal = new AbortController().signal;

    expect(await sources.approval.expectedDigest(signal)).toBe(digest);
    expect(await sources.candidate.read(signal)).toEqual(review);

    let observed = '';
    expect(await sources.credentials.withValue(async secret => {
      observed = secret;
      return 'ok';
    })).toBe('ok');
    expect(observed).toBe('SYNTHETIC_CORE_SECRET');
  });

  it('fails closed for malformed approved digest and unsafe secret permissions', async () => {
    const f = await fixture();
    roots.push(f.anchor);
    const review = encodeRuntimeReview(f.review);
    await writeFile(`${f.base}/config/runtime-review.json`, review, { mode: 0o600 });
    await writeFile(`${f.base}/config/runtime-review.sha256`, 'not-a-digest\n', { mode: 0o600 });
    const secretPath = `${f.base}/secrets/mcp-internal-secret`;
    await writeFile(secretPath, 'SYNTHETIC_CORE_SECRET\n', { mode: 0o644 });

    const sources = createBootstrapFileSources({
      anchor: f.anchor,
      relative: 'installed',
      ownerUid: f.uid,
      runtimeUid: f.uid,
      acl: f.acl,
    });
    expect(await sources.approval.expectedDigest(new AbortController().signal)).toBeNull();
    await expect(sources.credentials.withValue(async () => 'unexpected')).rejects.toThrow(/^AUTH_BLOCKED$/);

    await chmod(secretPath, 0o600);
    const abort = new AbortController();
    abort.abort();
    expect(await sources.candidate.read(abort.signal)).toBeNull();
  });

  it('constructs production sources without reading the filesystem or changing fixed paths', () => {
    expect(systemBootstrapPaths).toEqual({
      aclHelper: '/Library/Application Support/HAAR/GramAgent/bootstrap/bin/file-acl',
      review: '/Library/Application Support/HAAR/GramAgent/config/runtime-review.json',
      reviewDigest: '/Library/Application Support/HAAR/GramAgent/config/runtime-review.sha256',
      secret: '/Library/Application Support/HAAR/GramAgent/secrets/mcp-internal-secret',
    });
    expect(() => createSystemBootstrapSources()).not.toThrow();
  });
});
