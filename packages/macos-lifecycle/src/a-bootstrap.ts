import { bindReviewedCoreRuntime, bindReviewedCoreRuntimeAt, type RuntimeEnvironment } from './adapters/runtime-authority.js';
import type { RuntimeLayout } from './adapters/runtime-directories.js';
import type { AclProbe } from './adapters/trusted-files.js';
import type { CoreCredentials } from './health-probe.js';
import {
  createReviewedBootstrap,
  type RuntimeReviewApproval,
  type RuntimeReviewCandidate,
} from './reviewed-bootstrap.js';
import type { SupervisorBootstrap } from './supervisor-entry.js';
import type { ReviewedTunnelProvider } from './tunnel-supervisor-runtime.js';

export interface AReviewedBootstrapOptions {
  readonly layout: RuntimeLayout;
  readonly acl: AclProbe;
  readonly environment: RuntimeEnvironment;
  readonly approval: RuntimeReviewApproval;
  readonly candidate: RuntimeReviewCandidate;
  readonly credentials: CoreCredentials;
  readonly tunnelProvider?: ReviewedTunnelProvider;
}

/**
 * A/WP-06 supervisor composition.
 *
 * All trust-bearing inputs are explicit local capabilities. No argv/env path,
 * network response, candidate release, or MCP request can select them.
 * The native installer must provision those capabilities independently before
 * the direct launchd entry is activated.
 */
export function createAReviewedSupervisorBootstrap(
  options: AReviewedBootstrapOptions,
): SupervisorBootstrap {
  const layout: RuntimeLayout = {
    anchor: options.layout.anchor,
    relative: options.layout.relative,
    ownerUid: options.layout.ownerUid,
  };
  const acl = options.acl;
  const environment = options.environment;

  return createReviewedBootstrap({
    approval: options.approval,
    candidate: options.candidate,
    credentials: options.credentials,
    ...(options.tunnelProvider === undefined
      ? {}
      : { tunnelProvider: options.tunnelProvider }),
    bind: (review, signal) =>
      bindReviewedCoreRuntimeAt(layout, review, acl, environment, signal),
  });
}

export interface ASystemReviewedBootstrapOptions {
  readonly acl: AclProbe;
  readonly approval: RuntimeReviewApproval;
  readonly candidate: RuntimeReviewCandidate;
  readonly credentials: CoreCredentials;
  readonly tunnelProvider?: ReviewedTunnelProvider;
}

/**
 * Production-scope A composition. The runtime layout, host and account
 * inspection are NOT caller-selectable: bindReviewedCoreRuntime fixes them to
 * the reviewed macOS deployment root, non-admin gram-agent, current UID/GID,
 * arm64 and Node 24. Only independently provisioned trust capabilities remain
 * injectable.
 */
export function createASystemReviewedSupervisorBootstrap(
  options: ASystemReviewedBootstrapOptions,
): SupervisorBootstrap {
  return createReviewedBootstrap({
    approval: options.approval,
    candidate: options.candidate,
    credentials: options.credentials,
    ...(options.tunnelProvider === undefined
      ? {}
      : { tunnelProvider: options.tunnelProvider }),
    bind: (review, signal) => bindReviewedCoreRuntime(review, options.acl, signal),
  });
}
