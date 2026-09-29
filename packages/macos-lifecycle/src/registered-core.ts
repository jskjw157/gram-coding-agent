import type { CoreRegistrationStore } from './core-registration.js';
import type { SupervisorDeps } from './supervisor.js';

/** Wrap only the existing managed native Core port; no arbitrary process API. */
export function withRegisteredCore(_core: SupervisorDeps['core'], _registration: Pick<CoreRegistrationStore, 'publish'>):
  SupervisorDeps['core'] { throw new Error('NOT_IMPLEMENTED'); }
