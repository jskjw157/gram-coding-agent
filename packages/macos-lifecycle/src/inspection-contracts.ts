import type { Role, ServiceConfig } from './contracts.js';

/** Read-only internal ports. These are not user-supplied proof or an IPC schema.
 * Native adapters must establish the evidence; this interface grants no trust.
 */
export interface Inspector {
  host(): Promise<unknown>;
  account(): Promise<unknown>;
  release(config: ServiceConfig, expectedDigest: string): Promise<unknown>;
  installation(): Promise<unknown>;
  ports(roles: readonly Role[]): Promise<unknown>;
  plistValidity(plists: readonly string[]): Promise<unknown>;
}
export interface PreflightFacts {
  nativeMac: boolean; node24: boolean; validAccount: boolean;
  trustedRelease: boolean; safePaths: boolean;
  ownedInstallation: boolean; freeOrOwnedPorts: boolean;
}
