import type { ServiceConfig } from '../contracts.js';
import type { ExecutionLeaseStore } from '../execution-lease.js';
import type { CoreAuthority } from './native-core.js';
import type { AclProbe } from './trusted-files.js';
import type { LocalAccount } from './macos-inspection.js';
import type { RuntimeLayout } from './runtime-directories.js';

/** Independently reviewed input, NOT a field read from candidate release.json. */
export interface RuntimeReview {
  config: ServiceConfig;
  configDigest: string;
  nodeDigest: string;
  fileAclDigest: string;
  peerOwnerDigest: string;
}
export interface RuntimeEnvironment {
  host(): { platform: string; arch: string; nodeVersion: string };
  account(): Promise<LocalAccount | null>;
  identity(): { uid: number; gid: number; groups: readonly number[] };
}
export interface ReviewedCoreRuntime { authority: CoreAuthority; execution: ExecutionLeaseStore }
export async function bindReviewedCoreRuntime(_review?: RuntimeReview, _bootstrapAcl?: AclProbe,
  _signal?: AbortSignal): Promise<ReviewedCoreRuntime | null> { throw new Error('NOT_IMPLEMENTED'); }
/** Internal fixture/composition port, never configuration or MCP path input. */
export async function bindReviewedCoreRuntimeAt(_layout: RuntimeLayout, _review: RuntimeReview,
  _bootstrapAcl: AclProbe, _environment: RuntimeEnvironment, _signal: AbortSignal): Promise<ReviewedCoreRuntime | null> {
  throw new Error('NOT_IMPLEMENTED');
}
