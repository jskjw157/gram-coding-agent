import { createPrivateRecordFiles, type StateDirectoryPolicy, type CircuitFileIo } from './private-record-files.js';
import type { RecordFiles } from '../telemetry-store.js';
/** Fixed private discovery record; no initialization or deletion API. */
export function createCoreProcessFilesAt(policy: StateDirectoryPolicy, io?: CircuitFileIo): RecordFiles {
  return createPrivateRecordFiles('process', policy, io);
}
