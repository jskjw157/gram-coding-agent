import { createPrivateRecordFiles, type StateDirectoryPolicy, type CircuitFileIo } from './private-record-files.js';
import type { RecordFiles } from '../telemetry-store.js';

/** INTERNAL: separate, already-provisioned private run/log directory capabilities.
 * This does not authenticate helper provenance, create directories, bind the
 * production fixed root or expose arbitrary paths over CLI/MCP. No live status
 * or permission is inferred from successful construction or a readable record.
 */
export function createTelemetryFilesAt(run: StateDirectoryPolicy, logs: StateDirectoryPolicy, io?: CircuitFileIo): { status: RecordFiles; events: RecordFiles } {
  return Object.freeze({ status: createPrivateRecordFiles('status', run, io), events: createPrivateRecordFiles('events', logs, io) });
}
