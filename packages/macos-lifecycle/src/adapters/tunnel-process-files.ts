import type { RecordFiles } from '../telemetry-store.js';
import { createPrivateRecordFiles, type StateDirectoryPolicy, type CircuitFileIo } from './private-record-files.js';

/** Fixed private tunnel discovery record; no initialization or deletion API. */
export function createTunnelProcessFilesAt(policy: StateDirectoryPolicy, io?: CircuitFileIo): RecordFiles {
  return createPrivateRecordFiles('tunnel-process', policy, io);
}
