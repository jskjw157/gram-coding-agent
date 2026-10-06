import { rm, writeFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalConfigBytes } from './adapters/install-files.js';
import { readCandidateConfigAt } from './a-candidate-config.js';
import { fixture } from './test-support/runtime/fixture.js';

const roots: string[] = [];
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('fixed candidate service config', () => {
  it('accepts a root-reviewed candidate only when its sealed release verifies', async () => {
    const f = await fixture();
    roots.push(f.anchor);
    await writeFile(
      `${f.base}/config/candidate-service.json`,
      canonicalConfigBytes(f.review.config),
      { mode: 0o600 },
    );

    expect(await readCandidateConfigAt({
      anchor: f.anchor,
      ownerUid: f.uid,
      appRelative: 'installed',
      acl: f.acl,
    })).toEqual(f.review.config);
  });

  it('rejects a candidate whose release digest is not the installed sealed release', async () => {
    const f = await fixture();
    roots.push(f.anchor);
    const bad = {
      ...f.review.config,
      releaseDigest: 'f'.repeat(64),
    };
    await writeFile(
      `${f.base}/config/candidate-service.json`,
      canonicalConfigBytes(bad),
      { mode: 0o600 },
    );

    await expect(readCandidateConfigAt({
      anchor: f.anchor,
      ownerUid: f.uid,
      appRelative: 'installed',
      acl: f.acl,
    })).rejects.toBeDefined();
  });
});
