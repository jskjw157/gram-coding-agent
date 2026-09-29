import type { LifecycleStore } from '../lifecycle-store.js';
import type { TelemetryStore } from '../telemetry-store.js';
import type { RuntimeDirectories } from './runtime-directories.js';
export interface RuntimeStores { lifecycle: LifecycleStore; telemetry: TelemetryStore }
/** Consume existing directory witnesses; never initialize or reset state. */
export function createRuntimeStores(_directories: RuntimeDirectories): RuntimeStores {
  throw new Error('NOT_IMPLEMENTED');
}
