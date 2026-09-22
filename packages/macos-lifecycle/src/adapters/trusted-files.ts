import type { FileHandle } from 'node:fs/promises';
export type AclProbe = (file: FileHandle) => Promise<boolean>;
export type InventoryEntry = { path: string; kind: 'directory' } | { path: string; kind: 'file'; executable: boolean } | { path: string; kind: 'link'; target: string };
export interface ReleaseFiles {
  read(path: string, limit: number): Promise<Buffer>;
  hash(path: string, limit: number): Promise<string>;
  inventory(): Promise<InventoryEntry[]>;
}
/** Internal trusted-root port; not a CLI or MCP configuration. */
export function createTrustedFiles(anchor: string, ownerUid: number, acl: AclProbe): ReleaseFiles {
  void anchor; void ownerUid; void acl;
  return {
    async read() { throw new Error('NOT_IMPLEMENTED'); },
    async hash() { throw new Error('NOT_IMPLEMENTED'); },
    async inventory() { throw new Error('NOT_IMPLEMENTED'); },
  };
}
