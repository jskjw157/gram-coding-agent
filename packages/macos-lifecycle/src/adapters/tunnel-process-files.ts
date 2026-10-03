import type { RecordFiles } from '../telemetry-store.js';
import { createPrivateRecordFiles, type StateDirectoryPolicy, type CircuitFileIo } from './private-record-files.js';

/** RED scaffold: tunnel support must not weaken the existing core process family. */
export function createTunnelProcessFilesAt(policy: StateDirectoryPolicy, io?: CircuitFileIo): RecordFiles {
  return createPrivateRecordFiles('process', policy, io);
}
