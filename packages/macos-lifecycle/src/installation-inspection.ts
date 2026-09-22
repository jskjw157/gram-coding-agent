import type { Role, ServiceConfig } from './contracts.js';
import type { LocalAccount } from './adapters/macos-inspection.js';
import type { RegistryObservation } from './adapters/macos-service-probes.js';
import type { PathPresence } from './adapters/trusted-presence.js';

export type InstallFile = 'configuration' | 'manifest' | 'journal' | 'core' | 'tunnel';
export interface InstallationIO {
  presence(file: InstallFile): Promise<PathPresence>;
  read(file: InstallFile, limit: number): Promise<Buffer>;
  registry(): Promise<RegistryObservation | null>;
  verifyRelease(config: ServiceConfig): Promise<boolean>;
}
export interface InstallationEvidence {
  owned: true; safePaths: true; digest: string | null;
  present: Record<Role, boolean>; enabled: Record<Role, boolean>;
}
/** Nonimplementing TDD scaffold: never claims installation ownership. */
export async function inspectInstallation(account: LocalAccount, io: InstallationIO): Promise<InstallationEvidence> {
  void account; void io;
  throw new Error('NOT_IMPLEMENTED');
}
