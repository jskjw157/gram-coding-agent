import type { ChildProcess } from 'node:child_process';
import type { ServiceConfig } from './contracts.js';
import type { ExecutionLeaseStore } from './execution-lease.js';
import type { ReviewedTunnelRuntime } from './adapters/runtime-authority.js';
import type { TunnelCustodyPort, TunnelLaunchPlan } from './adapters/native-tunnel.js';

export interface ReviewedTunnelCustodyRuntime {
  configuration: Readonly<ServiceConfig>;
  execution: ExecutionLeaseStore;
  tunnelRuntime: ReviewedTunnelRuntime | null;
}

export function createReviewedTunnelCustody(
  _runtime: ReviewedTunnelCustodyRuntime,
  _launch: (plan: Readonly<TunnelLaunchPlan>) => ChildProcess,
): TunnelCustodyPort | null {
  throw new Error('NOT_IMPLEMENTED');
}
