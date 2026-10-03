import { root } from './contracts.js';
import { configDigest, parseConfig } from './config.js';
import { abortable, type CoreCredentials } from './health-probe.js';
import { decodeRuntimeReview } from './runtime-review.js';
import { createReviewedServiceSession } from './service-session.js';
import { createReviewedTunnelSupervisor, type ReviewedTunnelProvider } from './tunnel-supervisor-runtime.js';
import type { SupervisorBootstrap, SupervisorInvocation } from './supervisor-entry.js';
import type { ReviewedServiceRuntime, RuntimeReview } from './adapters/runtime-authority.js';

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
  tunnelProvider?: ReviewedTunnelProvider;
}

const CONFIG_PATH = `${root}/config/service.json`;
const DIGEST = /^[a-f0-9]{64}$/u;

function validInvocation(value: Readonly<SupervisorInvocation>): boolean {
  return (value.role === 'core' || value.role === 'tunnel') && value.configPath === CONFIG_PATH;
}

export function createReviewedBootstrap(options: ReviewedBootstrapOptions): SupervisorBootstrap {
  const approval = options.approval.expectedDigest.bind(options.approval);
  const candidate = options.candidate.read.bind(options.candidate);
  const bind = options.bind.bind(options);
  const credentials = options.credentials;
  const tunnelProvider = options.tunnelProvider;

  return Object.freeze({
    async prepare(invocation: Readonly<SupervisorInvocation>, signal: AbortSignal) {
      try {
        if (!validInvocation(invocation) || signal.aborted) return null;

        const expected = await abortable(Promise.resolve(approval(signal)), signal);
        if (typeof expected !== 'string' || !DIGEST.test(expected) || signal.aborted) return null;

        const raw = await abortable(Promise.resolve(candidate(signal)), signal);
        if (!Buffer.isBuffer(raw) || signal.aborted) return null;
        const bytes = Buffer.from(raw);

        const review = decodeRuntimeReview(bytes, expected);
        if (review === null || signal.aborted) return null;

        const runtime = await abortable(Promise.resolve(bind(review, signal)), signal);
        if (runtime === null || signal.aborted) return null;

        const actual = parseConfig(runtime.configuration);
        if (configDigest(actual) !== review.configDigest
          || actual.releaseDigest !== review.config.releaseDigest
          || actual.releaseId !== review.config.releaseId
          || actual.runtimeUser !== review.config.runtimeUser
          || signal.aborted) return null;

        if (invocation.role === 'tunnel') {
          if (!actual.tunnel.enabled || !tunnelProvider) return null;
          const tunnel = createReviewedTunnelSupervisor(runtime, tunnelProvider);
          if (tunnel === null) return null;
          return createReviewedServiceSession(invocation.role, runtime, credentials, tunnel);
        }
        return createReviewedServiceSession(invocation.role, runtime, credentials);
      } catch {
        return null;
      }
    },
  });
}
