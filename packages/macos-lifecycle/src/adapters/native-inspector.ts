import { labels, root, type ServiceConfig, type Role } from '../contracts.js';
import type { Inspector } from '../inspection-contracts.js';
import type { InstallFile } from '../installation-inspection.js';
import type { ReleaseFiles, AclProbe } from './trusted-files.js';
import type { PathPresence } from './trusted-presence.js';
import type { LocalAccount } from './macos-inspection.js';
import type { RegistryObservation, PortState } from './macos-service-probes.js';

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
export function composeInspector(ports: NativeInspectionPorts): Inspector {
  void ports; throw new Error('NOT_IMPLEMENTED');
}
export function createMacInspector(trustedAcl?: AclProbe): Inspector {
  void trustedAcl; throw new Error('NOT_IMPLEMENTED');
}
