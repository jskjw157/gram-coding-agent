import { bindReviewedCoreRuntime, bindReviewedCoreRuntimeAt, type RuntimeEnvironment } from './adapters/runtime-authority.js';
import type { RuntimeLayout } from './adapters/runtime-directories.js';
import type { AclProbe } from './adapters/trusted-files.js';
import type { CoreCredentials } from './health-probe.js';
import { root } from './contracts.js';
import { configDigest, parseConfig } from './config.js';
import { createReviewedServiceSession } from './service-session.js';
import { createReviewedTunnelSupervisor } from './tunnel-supervisor-runtime.js';
import {
  createReviewedBootstrap,
  type RuntimeReviewApproval,
  type RuntimeReviewCandidate,
} from './reviewed-bootstrap.js';
import type { SupervisorBootstrap } from './supervisor-entry.js';
import { createSystemBootstrapSources, type InstalledRuntimeReviewSource } from './a-system-sources.js';
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

/**
 * Direct launchd production composition. Construction performs no IO; all
 * fixed-file/ACL/secret checks occur lazily inside prepare/health use.
 * Tunnel provider wiring remains intentionally absent until external tunnel
 * credentials/provider compatibility are explicitly provisioned.
 */
export interface AInstalledReviewedBootstrapOptions {
  readonly review: InstalledRuntimeReviewSource;
  readonly credentials: CoreCredentials;
  readonly bind: (
    review: Awaited<ReturnType<InstalledRuntimeReviewSource['read']>>,
    signal: AbortSignal,
  ) => ReturnType<typeof bindReviewedCoreRuntime>;
  readonly tunnelProvider?: ReviewedTunnelProvider;
}

/**
 * Bootstrap from an already-authenticated installed review source.
 * The source itself must prove root-owned installation/config + sealed release
 * identity before returning a RuntimeReview. No self-hash approval is created
 * here.
 */
export function createAInstalledReviewedSupervisorBootstrap(
  options: AInstalledReviewedBootstrapOptions,
): SupervisorBootstrap {
  const reviewSource = options.review;
  const bind = options.bind;
  const credentials = options.credentials;
  const tunnelProvider = options.tunnelProvider;
  const configPath = `${root}/config/service.json`;

  return Object.freeze({
    async prepare(invocation, signal) {
      try {
        if (signal.aborted
          || (invocation.role !== 'core' && invocation.role !== 'tunnel')
          || invocation.configPath !== configPath) return null;

        const review = await reviewSource.read(signal);
        if (review === null || signal.aborted) return null;
        const runtime = await bind(review, signal);
        if (runtime === null || signal.aborted) return null;

        const actual = parseConfig(runtime.configuration);
        if (configDigest(actual) !== review.configDigest
          || actual.releaseId !== review.config.releaseId
          || actual.releaseDigest !== review.config.releaseDigest
          || actual.runtimeUser !== review.config.runtimeUser) return null;

        if (invocation.role === 'tunnel') {
          if (!actual.tunnel.enabled || tunnelProvider === undefined) return null;
          const tunnel = createReviewedTunnelSupervisor(runtime, tunnelProvider);
          if (tunnel === null) return null;
          return createReviewedServiceSession('tunnel', runtime, credentials, tunnel);
        }
        return createReviewedServiceSession('core', runtime, credentials);
      } catch {
        return null;
      }
    },
  });
}

/**
 * Direct launchd production composition. Construction performs no IO; all
 * fixed-file/ACL/secret checks occur lazily inside prepare/health use.
 * Tunnel provider wiring remains intentionally absent until external tunnel
 * credentials/provider compatibility are explicitly provisioned.
 */
export function createASystemSupervisorBootstrapFromFixedSources(): SupervisorBootstrap {
  const sources = createSystemBootstrapSources();
  return createAInstalledReviewedSupervisorBootstrap({
    review: sources.review,
    credentials: sources.credentials,
    bind: (review, signal) => review === null
      ? Promise.resolve(null)
      : bindReviewedCoreRuntime(review, sources.acl, signal),
  });
}
