import { describe, expect, it } from 'vitest';
import { apply, rollback } from '../install-service.js';
import { control } from '../local-control.js';
import { validateManifestBytes } from '../adapters/install-files.js';
import { inspectInstallation, type InstallationIO } from '../installation-inspection.js';
import { makeInstallFixture } from '../test-support/installer/fixture.js';

type Fixture = ReturnType<typeof makeInstallFixture>;

/** Review probes consume unchanged PR #144 logic and its existing in-memory
 * fixture. No administrator, service, credential, filesystem or network action.
 * Unlike that fixture's readPrior(), this view derives registry state from the
 * actual service-port state instead of hard-coding disabled/absent. */
function installedView(f: Fixture): InstallationIO {
  return {
    async presence(file) { return await f.ports.publish().readLive(file) === null ? 'absent' : 'file'; },
    async read(file) {
      const bytes = await f.ports.publish().readLive(file);
      if (bytes === null) throw new Error('MISSING_FIXTURE_FILE');
      return Buffer.from(bytes);
    },
    async registry() {
      const coreStopped = await f.ports.services().isStopped('core');
      const tunnelStopped = await f.ports.services().isStopped('tunnel');
      const tunnelPresent = await f.ports.publish().readLive('tunnel') !== null;
      return {
        jobs: { core: coreStopped ? 'absent' : 'present', tunnel: tunnelStopped ? 'absent' : 'present' },
        overrides: { core: coreStopped, tunnel: tunnelPresent ? tunnelStopped : null },
      };
    },
    async verifyRelease() { return true; },
  };
}
const account = { name: 'gram-agent' as const, uid: 501, gid: 501, admin: false, groupsComplete: true as const };

describe('PR144 review regressions — expectations from issue140', () => {
  it('R1: unknown rollback target must not return success without target resolution or restore', async () => {
    const f = makeInstallFixture({ existingInstall: true, closedSchema: [1], acceptedSets: [[1]] });
    let restored = 0;
    const original = f.ports.restore();
    f.ports.restore = () => ({ ...original, async restorePrior(prior) { restored++; await original.restorePrior(prior); } });
    const result = await rollback('f'.repeat(64), f.ports);
    expect({ ok: result.ok, restored }).toEqual({ ok: false, restored: 0 });
  });

  it('R2: closed schema must never be read while either service is running', async () => {
    const f = makeInstallFixture({ existingInstall: true, closedSchema: [1], acceptedSets: [[1]] });
    await f.ports.services().start('core');
    const originalRead = f.ports.readClosedSchema.bind(f.ports);
    const stoppedAtRead: boolean[] = [];
    f.ports.readClosedSchema = async () => {
      stoppedAtRead.push(await f.ports.services().isStopped('core') && await f.ports.services().isStopped('tunnel'));
      return originalRead();
    };
    const prior = await f.ports.readPrior();
    if (prior.digest === null) throw new Error('FIXTURE_PRIOR_REQUIRED');
    await rollback(prior.digest, f.ports);
    expect(stoppedAtRead.every(value => value === true)).toBe(true);
  });

  it('R3: denied manifest-owned removal must not be reported as successful uninstall', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const original = f.ports.restore();
    f.ports.restore = () => ({ ...original, async removeManifestOwned() { return false; } });
    const result = await control('uninstall', f.ports);
    expect(result.ok).toBe(false);
    expect(await f.ports.publish().readLive('core')).not.toBeNull();
  });

  it.each([
    { key: 'uid', value: 0 },
    { key: 'uid', value: '501' },
    { key: 'gid', value: -1 },
  ])('R4: manifest validator rejects invalid runtime $key=$value', async ({ key, value }) => {
    const f = makeInstallFixture({ existingInstall: true });
    const bytes = (await f.ports.readPrior()).manifest;
    if (bytes === null) throw new Error('FIXTURE_MANIFEST_REQUIRED');
    const manifest = JSON.parse(bytes.toString('utf8')) as { runtime: Record<string, unknown> };
    manifest.runtime[key] = value;
    expect(validateManifestBytes(Buffer.from(JSON.stringify(manifest)))).toBe(false);
  });

  it('R5: failed lock release must not be hidden by a clean COMMITTED result', async () => {
    const f = makeInstallFixture();
    f.ports.lock = async () => ({ acquired: true, async release() { throw new Error('FIXTURE_RELEASE_FAILURE'); } });
    await expect(apply(f.preview, f.config, f.ports)).resolves.toMatchObject({ ok: false });
  });

  it('R6: committed installation round-trips through the existing stopped-install reader', async () => {
    const f = makeInstallFixture();
    expect((await apply(f.preview, f.config, f.ports)).ok).toBe(true);
    await expect(inspectInstallation(account, installedView(f))).resolves.toMatchObject({ owned: true });
  });

  it('R7: fixture previous-install digest matches the real file-plus-registry reader', async () => {
    const f = makeInstallFixture({ existingInstall: true });
    const actual = await inspectInstallation(account, installedView(f));
    expect(f.preview.previousInstallDigest).toBe(actual.digest);
  });

  it('R8: a throwing authorization provider yields a bounded failure, not its raw exception', async () => {
    const f = makeInstallFixture();
    f.ports.authorizeLocalAdmin = async () => { throw new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'); };
    await expect(apply(f.preview, f.config, f.ports)).resolves.toMatchObject({ ok: false });
  });
});
