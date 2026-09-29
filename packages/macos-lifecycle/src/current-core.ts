import type { ServiceConfig } from './contracts.js';
import type { CoreRegistrationStore } from './core-registration.js';
import type { ExecutionLeaseStore } from './execution-lease.js';
import type { CoreConnections, CoreCredentials, CoreEvidence } from './health-probe.js';
import type { ServiceStatus } from './telemetry.js';
import type { CoreAuthority } from './adapters/native-core.js';
import type { ConnectedPeerVerifier } from './adapters/loopback-http.js';

/** Trusted local dependencies. Test connections are not a configuration option. */
export interface CurrentCoreDeps {
  registration: Pick<CoreRegistrationStore, 'read'>;
  execution: Pick<ExecutionLeaseStore, 'read'>;
  status(): Promise<ServiceStatus | null>;
  authority: CoreAuthority;
  credentials: CoreCredentials;
  now?(): number;
  connections?(verifier: ConnectedPeerVerifier): CoreConnections;
}
export function createCurrentCoreReader(_config: ServiceConfig, _deps: CurrentCoreDeps):
  (signal: AbortSignal) => Promise<CoreEvidence | null> { throw new Error('NOT_IMPLEMENTED'); }
