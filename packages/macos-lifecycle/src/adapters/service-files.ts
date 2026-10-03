import type { Role } from '../contracts.js';
import type { CircuitFiles } from '../lifecycle-store.js';
import { createPrivateRecordFiles, type StateDirectoryPolicy, type CircuitFileIo } from './private-record-files.js';
export type { StateDirectoryPolicy, CircuitFileIo } from './private-record-files.js';

/** Existing circuit API, filenames and validation preserved. Shared private-file
 * mechanics also serve telemetry; callers cannot select arbitrary destinations.
 * Trusted anchor/ACL and owned stopped recovery remain external prerequisites.
 */
export function createCircuitFilesAt(policy: StateDirectoryPolicy, io?: CircuitFileIo): CircuitFiles {
  const records = createPrivateRecordFiles('circuit', policy, io);
  return Object.freeze({
    async read(role: Role) { const result = await records.read(role); return result[0] ?? null; },
    async compareAndSwap(role: Role, expectedDigest: string | null, bytes: Buffer) {
      await records.compareAndSwap(role, [expectedDigest], 0, bytes);
    },
  });
}
