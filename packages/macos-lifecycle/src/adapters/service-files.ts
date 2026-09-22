import type * as fs from 'node:fs/promises';
import type { AclProbe } from './trusted-files.js';
import type { CircuitFiles } from '../lifecycle-store.js';
export interface StateDirectoryPolicy {
  anchor: string; relative: string; ancestorUid: number; stateUid: number; acl: AclProbe;
}
export type CircuitFileIo = Pick<typeof fs, 'open' | 'lstat' | 'rename' | 'unlink'>;
export function createCircuitFilesAt(policy: StateDirectoryPolicy, io?: CircuitFileIo): CircuitFiles {
  void policy; void io; throw new Error('NOT_IMPLEMENTED');
}
export async function createMacCircuitFiles(trustedAcl?: AclProbe): Promise<CircuitFiles> {
  void trustedAcl; throw new Error('NOT_IMPLEMENTED');
}
