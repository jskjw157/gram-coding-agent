import { describe, expect, it } from 'vitest';
import { makeInstallFixture } from '../installer/fixture.js';
import { readRealDigest } from './real-reader.js';

describe('B4 R7: fixture digest equals the real stopped-install reader (#149)', () => {
  it('existing core-only install matches inspectInstallation byte-for-byte', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected prior digest');
    await expect(readRealDigest(f)).resolves.toBe(prior.digest);
    await expect(readRealDigest(f)).resolves.toBe(f.preview.previousInstallDigest);
  });

  it('existing tunnel install matches inspectInstallation byte-for-byte', async () => {
    const f = makeInstallFixture({ existingInstall: true, tunnelEnabled: true });
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('expected prior digest');
    await expect(readRealDigest(f)).resolves.toBe(prior.digest);
  });

  it('fresh install has null digest on both paths', async () => {
    const f = makeInstallFixture();
    const prior = await f.ports.readPrior();
    expect(prior.digest).toBeNull();
    await expect(readRealDigest(f)).resolves.toBeNull();
  });

  it('running services are refused by the real reader, never masked', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const services = f.ports.services();
    const started = await services.start('core');
    expect(started.ok).toBe(true);
    // The content digest still exists, but the real stopped-install reader
    // refuses a running snapshot: the helper reports null instead of a
    // digest that would pretend the install is stopped.
    await expect(readRealDigest(f)).resolves.toBeNull();
    const prior = await f.ports.readPrior();
    expect(prior.digest).not.toBeNull();
  });
});
