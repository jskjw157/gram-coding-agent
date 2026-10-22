import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Trusted composition supplies only native policy-checked reads. No caller can
 * choose a host path, executable, source implementation or snapshot location. */
export interface LocalGitSnapshotSource {
  verify(): Promise<void>;
  list(path: string): Promise<{ name: string; type: 'file' | 'directory' | 'symlink' }[]>;
  read(path: string): Promise<{ bytes: Buffer; executable: boolean }>;
}
let active = 0;
// shortcut: complete captures cap native files at 1 MiB; use a bounded native streaming broker for larger Git packs.
const deny = () => new Error('Local Git snapshot denied');
async function privateDirectory(path: string): Promise<void> {
  if (await realpath(path) !== path) throw deny();
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) throw deny();
}
/** Complete bounded capture, not an atomic snapshot of concurrent writers.
 * Every source byte comes from the configured native containment broker. */
export async function createLocalGitSnapshot(source: LocalGitSnapshotSource, directory: string): Promise<{
  workspace: string; close(): Promise<void>;
}> {
  if (active >= 2) throw deny();
  active++;
  let capture: string | undefined;
  let released = false;
  const close = async () => {
    if (released) return;released = true;
    try {if (capture) await rm(capture, { recursive: true, force: false });}
    finally {active--;}
  };
  try {
    await privateDirectory(dirname(directory));
    try {await mkdir(directory, { mode: 0o700 });}
    catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
    await privateDirectory(directory);
    capture = await mkdtemp(join(directory, 'observation-'));
    const workspace = join(capture, 'workspace');await mkdir(workspace, { mode: 0o700 });
    let bytes = 0, entries = 0;
    const deadline = Date.now() + 30_000;
    const check = async () => {if (Date.now() >= deadline) throw deny();await source.verify();};
    const copy = async (relative: string) => {
      await check();const value = await source.read(relative);await check();
      if (!Buffer.isBuffer(value.bytes) || typeof value.executable !== 'boolean' || value.bytes.length > 1024 * 1024) throw deny();
      bytes += value.bytes.length;if (bytes > 256 * 1024 * 1024) throw deny();
      const file = await open(join(workspace, relative), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        value.executable ? 0o700 : 0o600);
      try {await file.writeFile(value.bytes);} finally {await file.close();}
    };
    const walk = async (relative: string, depth: number): Promise<void> => {
      if (depth > 32) throw deny();await check();
      const listing = await source.list(relative);await check();
      if (!Array.isArray(listing) || listing.length > 10000) throw deny();
      const names = new Set<string>();
      for (const entry of listing) {
        if (++entries > 20000 || !entry.name || entry.name === '.' || entry.name === '..' ||
            /[\\/\p{Cc}\p{Cf}]/u.test(entry.name) || names.has(entry.name)) throw deny();
        names.add(entry.name);
        const child = relative === '.' ? entry.name : relative + '/' + entry.name;
        if (child.length > 2048 || entry.type === 'symlink' || !['file', 'directory'].includes(entry.type)) throw deny();
        if (child === '.git/config.worktree' || child === '.git/commondir' ||
            child === '.git/objects/info/alternates' || child === '.git/objects/info/http-alternates') throw deny();
        // Git administrative hooks, attributes and reflogs are not executable
        // configuration for this reader. Worktree files have no omit patterns.
        if (child.startsWith('.git/') && !['HEAD', 'index', 'config', 'packed-refs', 'shallow', 'refs', 'objects', 'info'].includes(child.split('/')[1] ?? '')) continue;
        if (child.startsWith('.git/info/') && child !== '.git/info/exclude') continue;
        if (child === '.git' && entry.type !== 'directory') throw deny();
        if (entry.type === 'directory') {
          await mkdir(join(workspace, child), { mode: 0o700 });await walk(child, depth + 1);
        } else await copy(child);
      }
    };
    await walk('.', 0);await check();
    await mkdir(join(workspace, '.git/info'), { recursive: true, mode: 0o700 });
    await mkdir(join(workspace, '.git/objects'), { recursive: true, mode: 0o700 });
    return { workspace, close };
  } catch {await close();throw deny();}
}
