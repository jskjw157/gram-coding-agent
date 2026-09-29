import type { StateDirectoryPolicy, CircuitFileIo } from './private-record-files.js';
import type { RecordFiles } from '../telemetry-store.js';
/** Fixed private discovery record; no initialization or deletion API. */
export function createCoreProcessFilesAt(_policy: StateDirectoryPolicy, _io?: CircuitFileIo): RecordFiles {
  throw new Error('NOT_IMPLEMENTED');
}
