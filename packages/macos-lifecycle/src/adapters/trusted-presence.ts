import type { AclProbe } from './trusted-files.js';
export type PathPresence = 'absent' | 'file' | 'directory';
export async function probeTrustedPath(anchor: string, ownerUid: number, acl: AclProbe, relative: string): Promise<PathPresence> {
  void anchor; void ownerUid; void acl; void relative;
  throw new Error('NOT_IMPLEMENTED');
}
