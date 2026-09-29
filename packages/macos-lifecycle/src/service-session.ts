import type { Role, ServiceConfig, Clock } from './contracts.js';
import type { SupervisorDeps } from './supervisor.js';
import type { RuntimeStores } from './adapters/runtime-stores.js';
export interface ServiceSession { run(signal: AbortSignal): Promise<number> }
export interface ServiceSessionDeps {
  stores: RuntimeStores;
  core: SupervisorDeps['core']; currentCore: SupervisorDeps['currentCore'];
  tunnel?: SupervisorDeps['tunnel']; confirmStopped?: SupervisorDeps['confirmStopped'];
  clock?: Clock; nextGeneration?: SupervisorDeps['nextGeneration'];
}
/** Internal composition only; never provisions credentials or state. */
export function createServiceSession(_role: Role, _config: ServiceConfig, _deps: ServiceSessionDeps): ServiceSession {
  throw new Error('NOT_IMPLEMENTED');
}
