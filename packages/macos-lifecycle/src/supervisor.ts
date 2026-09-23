import type { Clock, OwnedChild, Role, ServiceConfig } from './contracts.js';
import type { CoreEvidence } from './health-probe.js';
import type { LifecycleStore } from './lifecycle-store.js';
import type { TelemetryStore } from './telemetry-store.js';

export interface ManagedChild {
  child: OwnedChild;
  exited: Promise<void>;
}
export interface TunnelCompatibility { digest: string }
export type TunnelObservation = 'READY' | 'OFFLINE' | 'AUTH_BLOCKED' | 'UNKNOWN';
export interface SupervisorDeps {
  clock: Clock;
  lifecycle: LifecycleStore;
  telemetry: TelemetryStore;
  nextGeneration(role: Role): string;
  core: {
    spawn(config: ServiceConfig, generation: string, signal: AbortSignal): Promise<ManagedChild>;
    probe(child: OwnedChild, signal: AbortSignal): Promise<CoreEvidence>;
    stop(child: ManagedChild, deadlineMs: number, signal: AbortSignal): Promise<void>;
  };
  currentCore(signal: AbortSignal): Promise<CoreEvidence | null>;
  tunnel: {
    compatibility(config: ServiceConfig): Promise<TunnelCompatibility | null>;
    credentialAvailable(ref: 'test-tunnel-key'): Promise<boolean>;
    spawn(config: ServiceConfig, compatibility: TunnelCompatibility, core: CoreEvidence,
      generation: string, signal: AbortSignal): Promise<ManagedChild>;
    probe(child: OwnedChild, core: CoreEvidence, signal: AbortSignal): Promise<TunnelObservation>;
    stop(child: ManagedChild, deadlineMs: number, signal: AbortSignal): Promise<void>;
  };
}

export function dependencyDelayMs(_attempt: number): number {
  throw new Error('NOT_IMPLEMENTED');
}
export async function runSupervisor(_role: Role, _config: ServiceConfig, _deps: SupervisorDeps,
  _signal: AbortSignal): Promise<number> {
  throw new Error('NOT_IMPLEMENTED');
}
