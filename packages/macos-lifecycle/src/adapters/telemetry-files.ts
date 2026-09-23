import type { StateDirectoryPolicy, CircuitFileIo } from './service-files.js';
import type { RecordFiles } from '../telemetry-store.js';
export function createTelemetryFilesAt(run: StateDirectoryPolicy, logs: StateDirectoryPolicy, io?: CircuitFileIo): { status: RecordFiles; events: RecordFiles } {
  void run; void logs; void io; throw new Error('NOT_IMPLEMENTED');
}
