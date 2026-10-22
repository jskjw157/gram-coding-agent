/** Test-only source for real Git fixtures. Production uses the configured native
 * Windows/POSIX broker in OwnerWorkspaceRuntime, never this host-filesystem port. */
import { constants } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { LocalGitSnapshotSource } from './local-git-read-snapshot.js';
export function localGitFixtureSource(root: string): LocalGitSnapshotSource {
  const deny = () => new Error('Fixture snapshot denied');
  const anchored = async (relative: string, file: boolean): Promise<FileHandle> => {
    const parts = relative === '.' ? [] : relative.split('/');
    if (parts.some(p => !p || p === '.' || p === '..')) throw deny();
    let handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (let i = 0; i < parts.length; i++) {
        const next = await open(`/proc/self/fd/${handle.fd}/${parts[i]}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
          (i === parts.length - 1 && file ? 0 : constants.O_DIRECTORY));
        await handle.close();handle = next;
        const path = await realpath(`/proc/self/fd/${handle.fd}`);
        if (path !== root && !path.startsWith(root + '/')) throw deny();
      }
      return handle;
    } catch (error) {await handle.close();throw error;}
  };
  return {
    verify: async () => {if (await realpath(root) !== root || !(await stat(root)).isDirectory()) throw deny();},
    list: async relative => {
      const handle = await anchored(relative, false);
      try {
        const directory = await opendir(`/proc/self/fd/${handle.fd}`);
        const entries: Awaited<ReturnType<LocalGitSnapshotSource['list']>> = [];
        for await (const item of directory) {
          if (entries.length >= 10000) throw deny();
          entries.push({ name: item.name, type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'symlink' });
        }
        return entries;
      } finally {await handle.close();}
    },
    read: async relative => {
      const handle = await anchored(relative, true);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.nlink !== 1n || before.size > 1024n * 1024n) throw deny();
        const bytes = await handle.readFile();const after = await handle.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw deny();
        return { bytes, executable: (before.mode & 0o111n) !== 0n };
      } finally {await handle.close();}
    },
  };
}
