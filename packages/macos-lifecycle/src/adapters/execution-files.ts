import type { RecordFiles } from '../telemetry-store.js';
import { createPrivateRecordFiles, type StateDirectoryPolicy, type CircuitFileIo } from './private-record-files.js';
/** Fixed core.execution.json/tunnel.execution.json under a provisioned private
 * run directory. Missing paths are never created by an execution attempt. */
export function createExecutionFilesAt(policy: StateDirectoryPolicy, io?: CircuitFileIo): RecordFiles {
  return createPrivateRecordFiles('execution', policy, io);
}
