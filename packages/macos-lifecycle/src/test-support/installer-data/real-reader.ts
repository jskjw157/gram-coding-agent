import type { LocalAccount } from '../../adapters/macos-inspection.js';
import type { RegistryObservation } from '../../adapters/macos-service-probes.js';
import type { PathPresence } from '../../adapters/trusted-presence.js';
import {
  inspectInstallation,
  type InstallFile,
  type InstallationIO,
} from '../../installation-inspection.js';
import type { PublishKind } from '../../installation-transaction/contracts.js';
import type { InstallFixture } from '../installer/fixture.js';

/** Lab account matching the fixture runtime identity. */
export const FIXTURE_ACCOUNT: LocalAccount = {
  name: 'gram-agent',
  uid: 501,
  gid: 501,
  admin: false,
  groupsComplete: true,
};

/** Fixture-backed reader IO. Jobs report absent only while stopped; a
 * running service surfaces as present so the unchanged reader refuses it.
 */
export function fixtureIO(fixture: InstallFixture): InstallationIO {
  const publish = fixture.ports.publish();
  const services = fixture.ports.services();
  return {
    async presence(file: InstallFile): Promise<PathPresence> {
      const value = await publish.readLive(file as PublishKind);
      return value === null ? 'absent' : 'file';
    },
    async read(file: InstallFile, limit: number): Promise<Buffer> {
      const value = await publish.readLive(file as PublishKind);
      if (value === null) throw new Error('FOREIGN_SERVICE');
      if (!Buffer.isBuffer(value) || value.length === 0 || value.length > limit) {
        throw new Error('FOREIGN_SERVICE');
      }
      return Buffer.from(value);
    },
    async registry(): Promise<RegistryObservation | null> {
      const coreStopped = await services.isStopped('core');
      const tunnelStopped = await services.isStopped('tunnel');
      const manifest = await publish.readLive('manifest');
      let coreOverride: boolean | null = null;
      let tunnelOverride: boolean | null = null;
      if (manifest !== null) {
        coreOverride = true;
        const tunnel = await publish.readLive('tunnel');
        tunnelOverride = tunnel === null ? null : true;
      }
      return {
        jobs: {
          core: coreStopped ? 'absent' : 'present',
          tunnel: tunnelStopped ? 'absent' : 'present',
        },
        overrides: { core: coreOverride, tunnel: tunnelOverride },
      };
    },
    async verifyRelease(config): Promise<boolean> {
      return config.releaseDigest === fixture.config.releaseDigest
        && config.releaseId === fixture.config.releaseId;
    },
  };
}

/** Fixture digest through the unchanged production reader. Returns the
 * reader digest for stopped installs and null wherever the reader refuses
 * (fresh, foreign, or running snapshots). No parallel digest algorithm.
 */
export async function readRealDigest(fixture: InstallFixture): Promise<string | null> {
  try {
    const evidence = await inspectInstallation(FIXTURE_ACCOUNT, fixtureIO(fixture));
    return evidence.digest;
  } catch {
    return null;
  }
}
