import type { ChildProcess } from 'node:child_process';
import { parseConfig } from './config.js';
import type { ServiceConfig } from './contracts.js';
import { ExecutionLeaseStore } from './execution-lease.js';
import type { ReviewedTunnelRuntime } from './adapters/runtime-authority.js';
import { createNativeTunnelCustody, type TunnelCustodyPort, type TunnelLaunchPlan } from './adapters/native-tunnel.js';

export interface ReviewedTunnelCustodyRuntime {
  configuration: Readonly<ServiceConfig>;
  execution: ExecutionLeaseStore;
  tunnelRuntime: ReviewedTunnelRuntime | null;
}

/** Compose already-reviewed tunnel authority with the same durable execution
 * store used by the runtime. Construction performs no launch, credential read,
 * provider request or reservation acquisition.
 */
export function createReviewedTunnelCustody(
  runtime: ReviewedTunnelCustodyRuntime,
  launch: (plan: Readonly<TunnelLaunchPlan>) => ChildProcess,
): TunnelCustodyPort | null {
  try {
    if (typeof launch !== 'function' || !(runtime.execution instanceof ExecutionLeaseStore)) return null;
    const config = parseConfig(runtime.configuration);
    const reviewed = runtime.tunnelRuntime;
    if (!config.tunnel.enabled) return null;
    if (!reviewed || typeof reviewed.authority?.acquire !== 'function'
      || reviewed.compatibility?.digest !== config.tunnel.compatibilityDigest) return null;
    const authority = reviewed.authority;
    return createNativeTunnelCustody({
      authority,
      execution: runtime.execution,
      launch: plan => launch(plan),
    });
  } catch {
    return null;
  }
}
