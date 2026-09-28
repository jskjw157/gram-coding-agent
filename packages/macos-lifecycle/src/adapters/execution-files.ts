import type { RecordFiles } from '../telemetry-store.js';
import type { StateDirectoryPolicy, CircuitFileIo } from './private-record-files.js';
export function createExecutionFilesAt(_policy: StateDirectoryPolicy, _io?: CircuitFileIo): RecordFiles {
  throw new Error('NOT_IMPLEMENTED');
}
