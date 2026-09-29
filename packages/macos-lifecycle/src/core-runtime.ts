import type { ServiceConfig } from './contracts.js';
import type { CoreCredentials } from './health-probe.js';
import type { SupervisorDeps } from './supervisor.js';
import type { ReviewedCoreRuntime } from './adapters/runtime-authority.js';
import { createNativeCorePort } from './adapters/native-core.js';
import { withRegisteredCore } from './registered-core.js';
import { createCurrentCoreReader } from './current-core.js';

/** Compose existing ports; installation/bootstrap/credentials are not provisioned
 * here. The native port retains the real child, the registry only publishes its
 * identity, and the independent observer reauthenticates that exact generation.
 * Construction does not create files, acquire a reservation or launch a child.
 */
export function createReviewedCorePorts(config: ServiceConfig, runtime: ReviewedCoreRuntime,
  credentials: CoreCredentials): Pick<SupervisorDeps, 'core' | 'currentCore'> {
  const native = createNativeCorePort({ authority: runtime.authority, execution: runtime.execution, credentials });
  return Object.freeze({ core: withRegisteredCore(native, runtime.registration),
    currentCore: createCurrentCoreReader(config, { authority: runtime.authority, execution: runtime.execution,
      registration: runtime.registration, status: () => runtime.readCoreStatus(), credentials }) });
}
