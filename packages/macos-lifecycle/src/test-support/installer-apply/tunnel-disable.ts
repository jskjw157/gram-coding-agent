import type { Preview, ServiceConfig } from '../../contracts.js';
import type {
  InstallPorts,
  PriorInstall,
  Revalidation,
} from '../../installation-transaction/contracts.js';
import { labConfig, makeInstallFixture, previewTokenFor } from '../installer/fixture.js';

/** B1 lane-owned tunnel-disable scenario. Prior install owns a tunnel plist
 * (tunnel-enabled release); the new config disables the tunnel. The fixture
 * builds both sides from one config, so the revalidation is overridden to
 * bind the new (tunnel-less) config to the tunnel-owning prior digest.
 */
export interface TunnelDisableScenario {
  preview: Preview;
  config: ServiceConfig;
  ports: InstallPorts;
  priorTunnelBytes: Buffer;
  databaseBytes(): Buffer;
}

export async function makeTunnelDisableScenario(foreignTunnel: boolean): Promise<TunnelDisableScenario> {
  const f = makeInstallFixture({ tunnelEnabled: true, existingInstall: true });
  const config: ServiceConfig = labConfig();
  const seed = await f.ports.readPrior();
  if (seed.digest === null || seed.tunnelPlist === null) {
    throw new Error('scenario needs a tunnel-owning installed prior');
  }
  const digest: string = seed.digest;
  const priorTunnelBytes: Buffer = seed.tunnelPlist;
  const preview: Preview = {
    ok: true,
    code: 'OK',
    configDigest: previewTokenFor(config, digest),
    previousInstallDigest: digest,
    releaseDigest: config.releaseDigest,
    roles: ['core'],
  };
  const ports: InstallPorts = {
    ...f.ports,
    revalidate: async (): Promise<Revalidation> => ({
      ok: true,
      code: 'OK',
      previewToken: preview.configDigest,
      priorDigest: digest,
      releaseId: config.releaseId,
      releaseDigest: config.releaseDigest,
      runtime: { name: 'gram-agent', uid: 501, gid: 501 },
    }),
    readPrior: async (): Promise<PriorInstall> => {
      const prior = await f.ports.readPrior();
      if (!foreignTunnel) return prior;
      return { ...prior, tunnelPlist: Buffer.from('foreign-tunnel-bytes', 'utf8') };
    },
  };
  return {
    preview,
    config,
    ports,
    priorTunnelBytes,
    databaseBytes: (): Buffer => f.databaseBytes(),
  };
}
