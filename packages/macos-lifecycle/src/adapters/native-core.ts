import type { ChildProcess } from 'node:child_process';
import type { AccountIdentity, ServiceConfig } from '../contracts.js';
import type { CoreCredentials } from '../health-probe.js';
import type { SupervisorDeps } from '../supervisor.js';
import type { ExecutableIdentity, NativePeerProofPort } from './owned-process.js';

export interface CoreLaunchPlan {
  file: string; args: readonly string[]; cwd: string; env: Readonly<Record<string, string>>;
}
/** INTERNAL trust dependency, not a remotely supplied attestation. */
export interface CoreLaunchGrant {
  configDigest: string; account: AccountIdentity; executable: ExecutableIdentity; proof: NativePeerProofPort;
}
export interface CoreAuthority {
  acquire(config: ServiceConfig, signal: AbortSignal): Promise<CoreLaunchGrant | null>;
}
export interface NativeCoreOptions {
  authority?: CoreAuthority;
  credentials?: CoreCredentials;
  /** Internal launcher substitution for isolated tests, never a CLI/config input. */
  launch?: (plan: Readonly<CoreLaunchPlan>) => ChildProcess;
}
export function coreLaunchPlan(_config: ServiceConfig): Readonly<CoreLaunchPlan> {
  throw new Error('NOT_IMPLEMENTED');
}
export function createNativeCorePort(_options: NativeCoreOptions = {}): SupervisorDeps['core'] {
  throw new Error('NOT_IMPLEMENTED');
}
