import { labels, root, type ServiceConfig, type Role } from '../contracts.js';
import type { Inspector } from '../inspection-contracts.js';
import { inspectInstallation, type InstallationEvidence, type InstallFile } from '../installation-inspection.js';
import { parseConfig } from '../config.js';
import { inspectRelease } from '../release-inspection.js';
import { renderPlist } from '../launchd-plist.js';
import { createTrustedFiles, type ReleaseFiles, type AclProbe } from './trusted-files.js';
import { probeTrustedPath, type PathPresence } from './trusted-presence.js';
import { inspectMacHost, inspectMacAccount, type LocalAccount } from './macos-inspection.js';
import { inspectMacRegistry, inspectMacPorts, validateMacPlists, type RegistryObservation, type PortState } from './macos-service-probes.js';

export const installPaths = Object.freeze({
  configuration: `${root.slice(1)}/config/service.json`,
  manifest: `${root.slice(1)}/config/installation.json`,
  journal: `${root.slice(1)}/config/install-journal.json`,
  core: `Library/LaunchDaemons/${labels.core}.plist`,
  tunnel: `Library/LaunchDaemons/${labels.tunnel}.plist`,
});
/** INTERNAL ports, not CLI/MCP input. Test anchors are never deployment proof. */
export interface NativeInspectionPorts {
  host(): Promise<unknown>;
  account(): Promise<LocalAccount | null>;
  releaseFiles(config: ServiceConfig): ReleaseFiles;
  presence(file: InstallFile): Promise<PathPresence>;
  read(file: InstallFile, limit: number): Promise<Buffer>;
  registry(): Promise<RegistryObservation | null>;
  ports(): Promise<Record<Role, PortState>>;
  plistValidity(plists: readonly string[]): Promise<boolean>;
}
function accountCopy(value: LocalAccount | null): LocalAccount | null {
  if (value === null) return null;
  return { name: value.name, uid: value.uid, gid: value.gid, admin: value.admin, groupsComplete: value.groupsComplete };
}

/** One instance per preview. No transport, credential or mutation port exists.
 * Even the test composition performs actual release and installation validation;
 * no adapter is allowed to supply a precomputed trustedRelease/owned boolean.
 */
export function composeInspector(ports: NativeInspectionPorts): Inspector {
  const io = Object.freeze({ ...ports });
  let phase = 0;
  let account: LocalAccount | null = null;
  let config: ServiceConfig | null = null;
  let installation: InstallationEvidence | null = null;
  let wanted: Role[] = [];
  const take = (expected: number) => {
    if (phase !== expected) { phase = -1; throw new Error('INVALID_INSPECTION_SEQUENCE'); }
    phase++;
  };
  const verifiedRelease = async (candidate: ServiceConfig, digest: string) => {
    const normalized = parseConfig(candidate);
    return inspectRelease(normalized, digest, io.releaseFiles(parseConfig(normalized)));
  };
  const installed = async (): Promise<InstallationEvidence> => {
    if (account === null) throw new Error('ACCOUNT_INVALID');
    return inspectInstallation({ ...account }, {
      presence: io.presence, read: io.read, registry: io.registry,
      async verifyRelease(candidate) {
        const result = await verifiedRelease(candidate, candidate.releaseDigest);
        return result.verified === true && result.safePaths === true && result.digest === candidate.releaseDigest;
      },
    });
  };
  const inspector: Inspector = {
    async host() { take(0); return io.host(); },
    async account() { take(1); account = accountCopy(await io.account()); return accountCopy(account); },
    async release(candidate, digest) {
      take(2);
      if (account === null) throw new Error('ACCOUNT_INVALID');
      config = parseConfig(candidate);
      return verifiedRelease(parseConfig(config), digest);
    },
    async installation() {
      take(3); installation = await installed();
      return { ...installation, present: { ...installation.present }, enabled: { ...installation.enabled } };
    },
    async ports(requested) {
      take(4);
      if (config === null) throw new Error('INVALID_CONFIG');
      wanted = config.tunnel.enabled ? ['core', 'tunnel'] : ['core'];
      if (!Array.isArray(requested) || JSON.stringify(requested) !== JSON.stringify(wanted)) throw new Error('INVALID_CONFIG');
      const observed = await io.ports();
      // Occupied is deliberately not upgraded to owned; Task 4 proves peers.
      return { core: observed.core, tunnel: observed.tunnel };
    },
    async plistValidity(plists) {
      take(5);
      if (config === null || installation === null || account === null) return false;
      const current = parseConfig(config);
      const expected = wanted.map(role => renderPlist(current, role));
      if (!Array.isArray(plists) || JSON.stringify(plists) !== JSON.stringify(expected)
        || await io.plistValidity([...expected]) !== true) return false;
      if (JSON.stringify(accountCopy(await io.account())) !== JSON.stringify(account)) return false;
      await verifiedRelease(current, current.releaseDigest);
      if (JSON.stringify(await installed()) !== JSON.stringify(installation)) return false;
      const finalPorts = await io.ports();
      return phase === 6 && wanted.every(role => finalPorts[role] === 'free');
    },
  };
  return Object.freeze(inspector);
}

/** Fixed '/' anchor and root ownership. trustedAcl is a LOCAL trusted dependency,
 * never a JSON/CLI/MCP option. Its independently authenticated implementation
 * must be supplied by the future trusted launcher. Omission denies every ACL
 * check: this factory does not bootstrap, select or trust an arbitrary helper.
 * No successful user-device deployment is implied by constructing these ports.
 */
export function createMacInspector(trustedAcl?: AclProbe): Inspector {
  const acl: AclProbe = trustedAcl ?? (async () => false);
  const files = createTrustedFiles('/', 0, acl);
  const path = (file: InstallFile): string => {
    if (!Object.hasOwn(installPaths, file)) throw new Error('UNSAFE_PATH');
    return installPaths[file];
  };
  return composeInspector({
    async host() { return inspectMacHost(); },
    account: inspectMacAccount,
    releaseFiles(candidate) {
      const normalized = parseConfig(candidate);
      return createTrustedFiles('/', 0, acl, `${root.slice(1)}/releases/${normalized.releaseId}`);
    },
    presence: file => probeTrustedPath('/', 0, acl, path(file)),
    read: (file, limit) => files.read(path(file), limit),
    registry: inspectMacRegistry,
    ports: inspectMacPorts,
    plistValidity: validateMacPlists,
  });
}
