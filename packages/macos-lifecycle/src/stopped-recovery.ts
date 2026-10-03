import type { Role, ServiceConfig } from './contracts.js';
import type { CoreRegistrationStore } from './core-registration.js';
import type { ExecutionLeaseStore } from './execution-lease.js';
import type { TunnelRegistrationStore } from './tunnel-registration.js';
import type { ExecutableIdentity, NativePeerProofPort } from './adapters/owned-process.js';

export interface StoppedRecoveryDeps {
  config: ServiceConfig;
  execution: ExecutionLeaseStore;
  coreRegistration: Pick<CoreRegistrationStore,'read'>;
  tunnelRegistration: Pick<TunnelRegistrationStore,'read'> | null;
  proof: NativePeerProofPort;
  executable(role: Role, signal: AbortSignal): Promise<ExecutableIdentity | null>;
}
export function createStoppedRecovery(_deps:StoppedRecoveryDeps):
  (role:Role,signal:AbortSignal)=>Promise<boolean> {
  return async()=>false;
}
