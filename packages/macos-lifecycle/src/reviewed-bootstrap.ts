import type { SupervisorBootstrap } from './supervisor-entry.js';
import type { ReviewedServiceRuntime, RuntimeReview } from './adapters/runtime-authority.js';
import type { CoreCredentials } from './health-probe.js';

export interface RuntimeReviewApproval {
  expectedDigest(signal: AbortSignal): Promise<string | null>;
}
export interface RuntimeReviewCandidate {
  read(signal: AbortSignal): Promise<Buffer | null>;
}
export interface ReviewedBootstrapOptions {
  approval: RuntimeReviewApproval;
  candidate: RuntimeReviewCandidate;
  bind(review: Readonly<RuntimeReview>, signal: AbortSignal): Promise<ReviewedServiceRuntime | null>;
  credentials: CoreCredentials;
}
export function createReviewedBootstrap(_options: ReviewedBootstrapOptions): SupervisorBootstrap {
  return Object.freeze({ async prepare() { return null; } });
}
