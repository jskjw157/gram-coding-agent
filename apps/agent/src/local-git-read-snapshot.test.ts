import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalGitSnapshot, type LocalGitSnapshotSource } from './local-git-read-snapshot.js';

const fixtures: string[] = [];
afterEach(() => {for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gram-git-snapshot-'));fixtures.push(directory);
  const files = new Map<string, string | Buffer>([['file.ts', 'source'], ['.git/HEAD', 'ref: refs/heads/main\n'],
    ['.git/config', '[core]\nfilemode = false\n'], ['.git/refs/heads/main', 'a'.repeat(40) + '\n']]);
  const source: LocalGitSnapshotSource = {
    verify: async () => {},
    list: async path => {
      const prefix = path === '.' ? '' : path + '/';const entries = new Map<string, 'file' | 'directory'>();
      for (const name of files.keys()) if (name.startsWith(prefix)) {
        const rest = name.slice(prefix.length), slash = rest.indexOf('/');
        entries.set(slash < 0 ? rest : rest.slice(0, slash), slash < 0 ? 'file' : 'directory');
      }
      return [...entries].map(([name, type]) => ({ name, type }));
    },
    read: async path => ({ bytes: Buffer.from(files.get(path) ?? ''), executable: path.endsWith('.sh') }),
  };
  return { directory, source, files };
}
it('copies bounded observations as private bytes and removes only its own snapshot on close', async () => {
  const f = fixture();f.files.set('script.sh', '#!/bin/sh\n');
  const snapshot = await createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'));
  expect(readFileSync(join(snapshot.workspace, 'file.ts'), 'utf8')).toBe('source');
  expect(readFileSync(join(snapshot.workspace, '.git/HEAD'), 'utf8')).toContain('refs/heads/main');
  await snapshot.close();expect(() => readFileSync(join(snapshot.workspace, 'file.ts'))).toThrow();
});
it('fails the complete observation on source changes or unsupported alternate stores', async () => {
  const f = fixture();f.files.set('.git/objects/info/alternates', '/outside');
  await expect(createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'))).rejects.toThrow();
  f.files.delete('.git/objects/info/alternates');
  f.source.verify = async () => {throw new Error('changed source');};
  await expect(createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'))).rejects.toThrow();
});
it('rejects shared private-state roots and source symlinks rather than returning partial trees', async () => {
  const f = fixture();const shared = join(f.directory, 'shared');mkdirSync(shared);chmodSync(shared, 0o755);
  await expect(createLocalGitSnapshot(f.source, shared)).rejects.toThrow();
  f.source.list = async () => [{ name: 'alias', type: 'symlink' }];
  await expect(createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'))).rejects.toThrow();
});
it('fails the whole request on oversized files, oversized enumeration, excessive depth and expiry', async () => {
  const f = fixture();const directory = join(f.directory, 'snapshots');
  f.source.read = async () => ({ bytes: Buffer.alloc(1024 * 1024 + 1), executable: false });
  await expect(createLocalGitSnapshot(f.source, directory)).rejects.toThrow();
  f.source.list = async () => Array.from({ length: 10001 }, (_, i) => ({ name: String(i), type: 'file' as const }));
  await expect(createLocalGitSnapshot(f.source, directory)).rejects.toThrow();
  f.source.list = async () => [{ name: 'child', type: 'directory' }];
  await expect(createLocalGitSnapshot(f.source, directory)).rejects.toThrow();
  const clock = vi.spyOn(Date, 'now');let tick = 0;clock.mockImplementation(() => tick++ * 31000);
  try {await expect(createLocalGitSnapshot(f.source, directory)).rejects.toThrow();}
  finally {clock.mockRestore();}
});


function validGitIndex(paths: string[]): Buffer {
  const header = Buffer.alloc(12);header.write('DIRC', 0, 'ascii');
  header.writeUInt32BE(2, 4);header.writeUInt32BE(paths.length, 8);
  const entries = paths.map(name => {
    const entry = Buffer.alloc(62);const bytes = Buffer.from(name);
    entry.writeUInt16BE(bytes.length, 60);
    const unaligned = Buffer.concat([entry, bytes, Buffer.alloc(1)]);
    return Buffer.concat([unaligned, Buffer.alloc((8 - unaligned.length % 8) % 8)]);
  });
  const content = Buffer.concat([header, ...entries]);
  return Buffer.concat([content, createHash('sha1').update(content).digest()]);
}

it('skips only checksum-verified untracked generated root directories while retaining source and Git pack bytes', async () => {
  const f = fixture();const packPath = '.git/objects/pack/pack-' + 'a'.repeat(40) + '.pack';
  const pack = Buffer.alloc(1024 * 1024 + 100, 42);
  f.files.set('.git/index', validGitIndex(['file.ts']));
  f.files.set('node_modules/a.js', Buffer.from('ignored generated dependency'));
  f.files.set('.pnpm-store/cache.bin', Buffer.from([255, 128]));
  f.files.set(packPath, pack);
  const snapshot = await createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'));
  try {
    expect([...snapshot.skippedUntrackedDirectories].sort()).toEqual(['.pnpm-store', 'node_modules']);
    expect(readFileSync(join(snapshot.workspace, 'file.ts'), 'utf8')).toBe('source');
    expect(readFileSync(join(snapshot.workspace, packPath)).equals(pack)).toBe(true);
    expect(() => readFileSync(join(snapshot.workspace, 'node_modules/a.js'))).toThrow();
  } finally {await snapshot.close();}
});

it('does not discard untracked folders when Git index checksum is invalid', async () => {
  const f = fixture();
  const index = validGitIndex(['file.ts']);index[index.length - 1] = (index[index.length - 1] ?? 0) ^ 1;
  f.files.set('.git/index', index);f.files.set('node_modules/untracked.js', 'must remain visible');
  const snapshot = await createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'));
  try {
    expect(snapshot.skippedUntrackedDirectories).toEqual([]);
    expect(readFileSync(join(snapshot.workspace, 'node_modules/untracked.js'), 'utf8')).toBe('must remain visible');
  } finally {await snapshot.close();}
});

it('still rejects ordinary >1MiB files outside the fixed Git pack namespace', async () => {
  const f = fixture();f.files.set('.git/index', validGitIndex(['file.ts', 'large.ts']));
  f.files.set('large.ts', Buffer.alloc(1024 * 1024 + 1));
  await expect(createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'))).rejects.toThrow();
});

it('captures independent files with bounded parallel native reads instead of a serial process-launch waterfall', async () => {
  const f = fixture();for (let i = 0; i < 32; i++) f.files.set(`parallel-${i}.ts`, `source-${i}`);
  const read = f.source.read;let active = 0, maximum = 0;
  f.source.read = async path => {
    active++;maximum = Math.max(maximum, active);
    try {await new Promise(resolve => setTimeout(resolve, 2));return await read(path);}
    finally {active--;}
  };
  const snapshot = await createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'));
  try {
    for (let i = 0; i < 32; i++) expect(readFileSync(join(snapshot.workspace, `parallel-${i}.ts`), 'utf8')).toBe(`source-${i}`);
    expect(maximum).toBeGreaterThan(8);expect(maximum).toBeLessThanOrEqual(16);expect(active).toBe(0);
  } finally {await snapshot.close();}
});

it('drains in-flight sibling reads before rejecting and removing a failed capture', async () => {
  const f = fixture();for (let i = 0; i < 16; i++) f.files.set(`failure-${i}.ts`, 'source');
  const read = f.source.read;let active = 0, completed = 0;
  f.source.read = async path => {
    if (!path.startsWith('failure-')) return read(path);
    active++;
    try {
      await new Promise(resolve => setTimeout(resolve, path === 'failure-0.ts' ? 1 : 20));
      if (path === 'failure-0.ts') throw new Error('source changed');
      return await read(path);
    } finally {active--;completed++;}
  };
  const directory = join(f.directory, 'snapshots');
  await expect(createLocalGitSnapshot(f.source, directory)).rejects.toThrow('Local Git snapshot denied');
  expect(active).toBe(0);expect(completed).toBeGreaterThan(1);expect(completed).toBeLessThan(16);
  expect(readdirSync(directory)).toEqual([]);
  const snapshot = await createLocalGitSnapshot({ ...f.source, read }, directory);
  await snapshot.close();expect(readdirSync(directory)).toEqual([]);
});

it.each(['read', 'list'] as const)('rejects project identity changes immediately after a native %s and removes the capture', async operation => {
  const f = fixture();let changed = false;
  const original = f.source[operation];
  if (operation === 'read') f.source.read = async path => {const value = await (original as LocalGitSnapshotSource['read'])(path);if (path === 'file.ts') changed = true;return value;};
  else f.source.list = async path => {const value = await (original as LocalGitSnapshotSource['list'])(path);changed = true;return value;};
  f.source.verify = async () => {if (changed) throw new Error('project replaced');};
  const directory = join(f.directory, 'snapshots');
  await expect(createLocalGitSnapshot(f.source, directory)).rejects.toThrow('Local Git snapshot denied');
  expect(readdirSync(directory)).toEqual([]);
});

it('serializes Git pack reads so a larger ordinary-file worker pool cannot multiply pack memory', async () => {
  const f = fixture();for (let i = 0; i < 4; i++) f.files.set(`.git/objects/pack/pack-${String(i).repeat(40)}.pack`, Buffer.alloc(32));
  const read = f.source.read;let active = 0, maximum = 0;
  f.source.read = async path => {
    if (!path.endsWith('.pack')) return read(path);
    active++;maximum = Math.max(maximum, active);
    try {await new Promise(resolve => setTimeout(resolve, 2));return await read(path);}
    finally {active--;}
  };
  const snapshot = await createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'));
  expect(maximum).toBe(1);await snapshot.close();
});

it('captures only Git metadata for commands that cannot read the worktree, without reading source or generated output', async () => {
  const f = fixture();f.files.set('generated/huge.bin', Buffer.alloc(1024 * 1024 + 1));
  const read = f.source.read;const reads: string[] = [];
  f.source.read = async path => {reads.push(path);if (!path.startsWith('.git/')) throw new Error('worktree read denied');return read(path);};
  const snapshot = await createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'), { includeWorktree: false });
  try {
    expect(reads.every(path => path.startsWith('.git/'))).toBe(true);
    expect(readFileSync(join(snapshot.workspace, '.git/HEAD'), 'utf8')).toContain('refs/heads/main');
    expect(() => readFileSync(join(snapshot.workspace, 'file.ts'))).toThrow();
    expect(snapshot.skippedUntrackedDirectories).toEqual([]);
  } finally {await snapshot.close();}
});
it('still denies forbidden alternate object stores during metadata-only capture', async () => {
  const f = fixture();f.files.set('.git/objects/info/alternates', '/outside');
  await expect(createLocalGitSnapshot(f.source, join(f.directory, 'snapshots'), { includeWorktree: false })).rejects.toThrow();
});
