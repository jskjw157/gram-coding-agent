import { LifecycleStore, type CircuitFiles } from '../lifecycle-store.js';
import { TelemetryStore, type RecordFiles } from '../telemetry-store.js';
import type { RuntimeDirectories } from './runtime-directories.js';
import { createCircuitFilesAt } from './service-files.js';
import { createTelemetryFilesAt } from './telemetry-files.js';
export interface RuntimeStores { lifecycle: LifecycleStore; telemetry: TelemetryStore }
/** Consume an independently checked directory witness, never serialized paths or
 * permission booleans. Reuse existing fixed record formats and durable CAS.
 * Construction performs no IO; every operation rechecks the pinned directories.
 */
export function createRuntimeStores(directories: RuntimeDirectories): RuntimeStores {
  const verify = directories.verify.bind(directories);
  const circuit = createCircuitFilesAt(directories.runPolicy);
  const telemetry = createTelemetryFilesAt(directories.runPolicy, directories.logsPolicy);
  const guardedCircuit: CircuitFiles = Object.freeze<CircuitFiles>({
    async read(role) { await verify(); const value = await circuit.read(role); await verify(); return value; },
    async compareAndSwap(role, expectedDigest, bytes) {
      await verify(); await circuit.compareAndSwap(role, expectedDigest, bytes); await verify();
    },
  });
  const guard = (raw: RecordFiles): RecordFiles => Object.freeze<RecordFiles>({
    async read(role) { await verify(); const value = await raw.read(role); await verify(); return value; },
    async compareAndSwap(role, expected, slot, bytes) {
      await verify(); await raw.compareAndSwap(role, expected, slot, bytes); await verify();
    },
  });
  return Object.freeze({ lifecycle: new LifecycleStore(guardedCircuit),
    telemetry: new TelemetryStore(guard(telemetry.status), guard(telemetry.events)) });
}
