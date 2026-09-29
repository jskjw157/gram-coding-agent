import type { ServiceConfig } from './contracts.js';
import type { CoreCredentials } from './health-probe.js';
import type { SupervisorDeps } from './supervisor.js';
import type { ReviewedCoreRuntime } from './adapters/runtime-authority.js';
/** Compose existing ports; installation/bootstrap/credentials are not provisioned here. */
export function createReviewedCorePorts(_config: ServiceConfig, _runtime: ReviewedCoreRuntime,
  _credentials: CoreCredentials): Pick<SupervisorDeps, 'core' | 'currentCore'> { throw new Error('NOT_IMPLEMENTED'); }
