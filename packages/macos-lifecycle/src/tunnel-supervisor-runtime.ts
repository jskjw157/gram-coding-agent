import type { ChildProcess } from 'node:child_process';
import type { OwnedChild, ServiceConfig } from './contracts.js';
import type { CoreEvidence } from './health-probe.js';
import type { SupervisorDeps, TunnelObservation } from './supervisor.js';
import type { ReviewedTunnelCustodyRuntime } from './tunnel-runtime.js';
import type { TunnelLaunchPlan } from './adapters/native-tunnel.js';

export interface ReviewedTunnelProvider {
  credentialAvailable(ref: 'test-tunnel-key'): Promise<boolean>;
  launch(plan: Readonly<TunnelLaunchPlan>): ChildProcess;
  probe(child: Readonly<OwnedChild>, core: Readonly<CoreEvidence>, signal: AbortSignal): Promise<TunnelObservation>;
}

export function createReviewedTunnelSupervisor(
  _runtime: ReviewedTunnelCustodyRuntime,
  _provider: ReviewedTunnelProvider,
): SupervisorDeps['tunnel'] | null {
  throw new Error('NOT_IMPLEMENTED');
}
