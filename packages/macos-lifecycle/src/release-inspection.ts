import type { ServiceConfig } from './contracts.js';
import type { ReleaseFiles } from './adapters/trusted-files.js';
export interface ReleaseEvidence { verified: true; safePaths: true; digest: string; sourceCommit: string; lockDigest: string; entries: readonly string[] }
export async function inspectRelease(config: ServiceConfig, expectedDigest: string, files: ReleaseFiles): Promise<ReleaseEvidence> {
  void config; void expectedDigest; void files;
  throw new Error('NOT_IMPLEMENTED');
}
