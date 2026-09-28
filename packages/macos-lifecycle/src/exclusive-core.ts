import type { ExecutionLeaseStore } from './execution-lease.js';
import type { SupervisorDeps } from './supervisor.js';
export function withExclusiveCore(_core: SupervisorDeps['core'], _leases: ExecutionLeaseStore): SupervisorDeps['core'] {
  throw new Error('NOT_IMPLEMENTED');
}
