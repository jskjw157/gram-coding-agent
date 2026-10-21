import type { ChildProcess } from 'node:child_process';
import { configDigest, parseConfig } from './config.js';
import type { OwnedChild } from './contracts.js';
import type { CoreEvidence } from './health-probe.js';
import type { ManagedChild, SupervisorDeps, TunnelObservation } from './supervisor.js';
import { createReviewedTunnelCustody, type ReviewedTunnelCustodyRuntime } from './tunnel-runtime.js';
import type { TunnelLaunchPlan } from './adapters/native-tunnel.js';

export interface ReviewedTunnelProvider {
  credentialAvailable(ref: 'test-tunnel-key'): Promise<boolean>;
  launch(plan: Readonly<TunnelLaunchPlan>): ChildProcess;
  probe(child: Readonly<OwnedChild>, core: Readonly<CoreEvidence>, signal: AbortSignal): Promise<TunnelObservation>;
}

function same(a: OwnedChild, b: OwnedChild): boolean {
  try {
    return a.role === 'tunnel' && b.role === 'tunnel'
      && a.pid === b.pid && a.uid === b.uid && a.startIdentity === b.startIdentity
      && a.generation === b.generation && a.releaseDigest === b.releaseDigest;
  } catch { return false; }
}
function observation(value: unknown): TunnelObservation {
  return value === 'READY' || value === 'OFFLINE' || value === 'AUTH_BLOCKED' || value === 'UNKNOWN'
    ? value : 'UNKNOWN';
}

/** Compose reviewed compatibility/custody with a separately trusted provider
 * capability. Provider readiness is accepted only while the exact native child
 * remains owned before and after the observation. No provider secrets are
 * accepted as arguments or stored by this layer.
 */
export function createReviewedTunnelSupervisor(
  runtime: ReviewedTunnelCustodyRuntime,
  provider: ReviewedTunnelProvider,
): SupervisorDeps['tunnel'] | null {
  try {
    const config = parseConfig(runtime.configuration);
    if (!config.tunnel.enabled || runtime.tunnelRuntime === null
      || runtime.tunnelRuntime.compatibility.digest !== config.tunnel.compatibilityDigest
      || typeof provider.credentialAvailable !== 'function'
      || typeof provider.launch !== 'function' || typeof provider.probe !== 'function') return null;

    const expectedConfigDigest = configDigest(config);
    const compatibility = Object.freeze({ digest: runtime.tunnelRuntime.compatibility.digest });
    const credential = provider.credentialAvailable.bind(provider);
    const launch = provider.launch.bind(provider);
    const providerProbe = provider.probe.bind(provider);
    const custody = createReviewedTunnelCustody(runtime, plan => launch(plan));
    if (custody === null) return null;

    let credentialReady = false;
    let active: ManagedChild | null = null;

    return Object.freeze<SupervisorDeps['tunnel']>({
      async compatibility(input) {
        try {
          const candidate = parseConfig(input);
          if (!candidate.tunnel.enabled || configDigest(candidate) !== expectedConfigDigest
            || candidate.tunnel.compatibilityDigest !== compatibility.digest) return null;
          return compatibility;
        } catch { return null; }
      },

      async credentialAvailable(ref) {
        if (ref !== 'test-tunnel-key') return false;
        try {
          credentialReady = (await credential(ref)) === true;
          return credentialReady;
        } catch {
          credentialReady = false;
          return false;
        }
      },

      async spawn(input, candidateCompatibility, core, generation, signal) {
        if (!credentialReady || signal.aborted) throw new Error('TUNNEL_START_FAILED');
        credentialReady = false;
        const managed = await custody.spawn(input, candidateCompatibility, core, generation, signal);
        active = managed;
        return managed;
      },

      async probe(child, core, signal) {
        const managed = active;
        if (!managed || signal.aborted || !same(child, managed.child)) return 'UNKNOWN';
        try {
          if (await custody.current(child, signal) !== true) return 'UNKNOWN';
          const observed = observation(await providerProbe(
            Object.freeze({ ...child }),
            Object.freeze({ ...core }),
            signal,
          ));
          if (signal.aborted || await custody.current(child, signal) !== true) return 'UNKNOWN';
          return observed;
        } catch { return 'UNKNOWN'; }
      },

      async stop(managed, deadlineMs, signal) {
        if (active !== managed) throw new Error('TUNNEL_STOP_UNKNOWN');
        await custody.stop(managed, deadlineMs, signal);
      },
    });
  } catch {
    return null;
  }
}
