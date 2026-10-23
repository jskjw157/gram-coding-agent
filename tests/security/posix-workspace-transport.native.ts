import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, linkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertOriginalMountTopology, FixedPosixWorkspaceTransport, PosixWorkspaceClient } from '../../apps/agent/src/posix-workspace-transport.js';
import { LocalOperationRepository, openDatabase } from '../../packages/persistence/src/index.js';
import { SecretRedactor } from '../../packages/secrets/src/index.js';
import { LocalRecoveryStore } from '../../apps/agent/src/local-recovery-store.js';
import { OwnerWorkspaceCore } from '../../apps/agent/src/owner-workspace-core.js';

it('keeps real native private-path, alias, CAS and controller-write denials under trusted local policy', async () => {
  const manifest = process.env.GRAM_POSIX_NATIVE_ARTIFACTS;
  if (!manifest) throw new Error('missing native fixture artifact manifest');
  const artifacts = JSON.parse(readFileSync(manifest, 'utf8')) as ConstructorParameters<typeof FixedPosixWorkspaceTransport>[0]['artifacts'];
  const fixture = mkdtempSync(join(homedir(), 'gram-owner-policy-native-'));
  const db = openDatabase(':memory:');
  try {
    const rootPath = join(fixture, 'root'), recoveryBase = join(fixture, 'captures'), vault = join(fixture, 'vault'), state = join(fixture, 'state');
    for (const path of [rootPath, recoveryBase, vault, state]) mkdirSync(path, { mode: 0o700 });
    mkdirSync(join(rootPath, 'controller'));
    writeFileSync(join(rootPath, 'private'), 'synthetic-private-canary');
    linkSync(join(rootPath, 'private'), join(rootPath, 'hardlink'));
    symlinkSync(join(rootPath, 'private'), join(rootPath, 'symlink'));
    writeFileSync(join(rootPath, 'file'), 'original');
    const st = statSync(vault, { bigint: true });
    const transport = new FixedPosixWorkspaceTransport({ rootPath, recoveryBase,
      recoveryRoot: { path: vault, identity: `${st.dev}:${st.ino}` }, artifacts });
    const backend = new PosixWorkspaceClient({ rootId: 'main', rootPath, writable: true,
      protectedPaths: ['private'], protectedMutationPaths: ['controller'], transport });
    const core = await OwnerWorkspaceCore.create({ roots: { main: { label: 'Fixture', kind: 'wsl-directory', wslPath: rootPath, writable: true } },
      backend, recovery: new LocalRecoveryStore({ stateDirectory: state }), journal: new LocalOperationRepository(db),
      redactor: new SecretRedactor(), unattendedRootIds: ['main'] });
    const before = await core.stat({ root: 'main', path: 'file' });
    if (!before.version) throw new Error('missing fixture version');
    const exported = await core.readBinary({ root: 'main', path: 'file', expectedVersion: before.version });
    expect(exported.authorizationSource).toBe('trusted-local-policy');
    expect(Buffer.from(exported.base64, 'base64').toString()).toBe('original');
    const changed = await core.write({ root: 'main', path: 'file', expectedVersion: before.version, content: 'PASSWORD=synthetic-policy-canary' });
    expect(changed.state).toBe('APPLIED');
    expect((await core.write({ root: 'main', path: 'file', expectedVersion: before.version, content: 'stale' })).state).toBe('DENIED');
    for (const path of ['private', 'hardlink', 'symlink']) {
      await expect(core.read({ root: 'main', path })).rejects.toThrow();
      await expect(core.readBinary({ root: 'main', path, expectedVersion: before.version })).rejects.toThrow();
    }
    expect((await core.write({ root: 'main', path: 'controller/file', expectedVersion: null, content: 'PASSWORD=blocked' })).state).toBe('DENIED');
    await expect(core.reveal({ root: 'main', path: 'file', expectedVersion: String(changed.version) })).rejects.toThrow();
    expect(JSON.stringify(db.prepare('SELECT * FROM local_workspace_operations').all())).not.toContain('synthetic-policy-canary');
  } finally { db.close();rmSync(fixture, { recursive: true, force: true }); }
}, 60000);

it('rejects a real whole-filesystem root bind alias even when mountinfo source root is slash', () => {
  const manifest = process.env.GRAM_POSIX_NATIVE_ARTIFACTS;
  if (!manifest) throw new Error('missing native fixture artifact manifest');
  const artifacts = JSON.parse(readFileSync(manifest, 'utf8')) as ConstructorParameters<typeof FixedPosixWorkspaceTransport>[0]['artifacts'];
  const fixture = mkdtempSync(join(homedir(), 'gram-posix-full-mount-'));
  try {
    const root = join(fixture, 'root');mkdirSync(root);
    writeFileSync(join(root, 'private'), 'synthetic-protected-state');
    const alias = join(fixture, 'filesystem alias');mkdirSync(alias);
    const selectedAlias = join(alias, root.slice(1));
    const result = spawnSync(artifacts.bubblewrap.path,
      ['--unshare-all', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc',
        '--bind', '/', alias, '--', artifacts.node.path, '--input-type=module', '-e',
        "import fs from 'node:fs'; process.stdout.write(JSON.stringify({mountinfo:fs.readFileSync('/proc/self/mountinfo','utf8'),reachable:fs.readFileSync(process.argv[1],'utf8')}));",
        join(selectedAlias, 'private')],
      { env: { OPENSSL_CONF: '/dev/null' }, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    const probe = JSON.parse(result.stdout) as { mountinfo: string; reachable: string };
    expect(probe.reachable).toBe('synthetic-protected-state');
    expect(() => assertOriginalMountTopology(selectedAlias, probe.mountinfo)).toThrow();
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

it('rejects actual nested file and selected directory bind aliases in an isolated mount namespace', () => {
  const manifest = process.env.GRAM_POSIX_NATIVE_ARTIFACTS;
  if (!manifest) throw new Error('missing native fixture artifact manifest');
  const artifacts = JSON.parse(readFileSync(manifest, 'utf8')) as ConstructorParameters<typeof FixedPosixWorkspaceTransport>[0]['artifacts'];
  const fixture = mkdtempSync(join(homedir(), 'gram-posix-mount-'));
  try {
    const root = join(fixture, 'root');mkdirSync(root);
    const alias = join(root, 'alias');writeFileSync(alias, 'placeholder');
    const outside = join(fixture, 'outside');writeFileSync(outside, 'synthetic-controller-state');
    const directoryAlias = join(fixture, 'directory alias');mkdirSync(directoryAlias);
    const result = spawnSync(artifacts.bubblewrap.path,
      ['--unshare-all', '--die-with-parent', '--bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--bind', outside, alias,
        '--bind', root, directoryAlias, '--', artifacts.node.path, '--input-type=module', '-e',
        "import fs from 'node:fs'; process.stdout.write(fs.readFileSync('/proc/self/mountinfo'));"],
      { env: { OPENSSL_CONF: '/dev/null' }, encoding: 'utf8', timeout: 20000, maxBuffer: 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0);
    expect(() => assertOriginalMountTopology(root, result.stdout)).toThrow();
    expect(() => assertOriginalMountTopology(directoryAlias, result.stdout)).toThrow();
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});
  it('runs real isolated ext4 operations through pinned root-owned artifacts', async () => {
    const manifest = process.env.GRAM_POSIX_NATIVE_ARTIFACTS;
    if (!manifest) throw new Error('missing native fixture artifact manifest');
    const artifacts = JSON.parse(readFileSync(manifest, 'utf8')) as ConstructorParameters<typeof FixedPosixWorkspaceTransport>[0]['artifacts'];
    const fixture = mkdtempSync(join(homedir(), 'gram-posix-transport-'));
    const rootPath = join(fixture, 'root');mkdirSync(rootPath);
    const recoveryBase = join(fixture, 'recovery');mkdirSync(recoveryBase, { mode: 0o700 });
    const vault = join(fixture, 'vault');mkdirSync(vault, { mode: 0o700 });
    const vaultStat = statSync(vault, { bigint: true });
    try {
      const transport = new FixedPosixWorkspaceTransport({ rootPath, recoveryBase,
        recoveryRoot: { path: vault, identity: `${vaultStat.dev}:${vaultStat.ino}` }, artifacts });
      const client = new PosixWorkspaceClient({ rootId: 'main', rootPath, writable: true, protectedPaths: ['private'], transport });
      writeFileSync(join(rootPath, 'private'), 'synthetic-controller-secret');
      const root = await client.invoke('main', { operation: 'stat', path: '.' });
      const encoded = (value: string) => Buffer.from(value).toString('base64');
      await client.invoke('main', { operation: 'mkdir', path: 'directory', expectedRootIdentity: root.rootIdentity });
      await client.invoke('main', { operation: 'write', path: 'directory/file', expectedRootIdentity: root.rootIdentity,
        expectedFileIdentity: null, expectedBase64: null, base64: encoded('original') });
      const before = await client.invoke('main', { operation: 'read', path: 'directory/file' });
      expect(before.base64).toBe(encoded('original'));
      await client.invoke('main', { operation: 'write', path: 'directory/file', expectedRootIdentity: root.rootIdentity,
        expectedFileIdentity: String(before.identity), expectedBase64: encoded('original'), base64: encoded('changed') });
      expect(readdirSync(join(rootPath, 'directory'))).toEqual(['file']);
      const archived = readdirSync(vault);
      expect(archived).toHaveLength(1);
      const archivedPath = join(vault, String(archived[0]));
      expect(readFileSync(archivedPath, 'utf8')).toBe('original');
      const archivedStat = statSync(archivedPath, { bigint: true });
      expect(`${archivedStat.dev}:${archivedStat.ino}`).toBe(before.identity);
      const changed = await client.invoke('main', { operation: 'read', path: 'directory/file' });
      await client.invoke('main', { operation: 'move', path: 'directory/file', destination: 'directory/moved',
        expectedRootIdentity: root.rootIdentity, expectedFileIdentity: String(changed.identity), expectedBase64: encoded('changed') });
      expect(readFileSync(join(rootPath, 'directory/moved'), 'utf8')).toBe('changed');
      const tree = await client.invoke('main', { operation: 'treeStat', path: 'directory' });
      const directoryPreimage = { expectedKind: 'directory' as const, expectedVersion: String(tree.version), expectedFileIdentity: String(tree.identity) };
      await client.invoke('main', { operation: 'move', path: 'directory', destination: 'relocated', expectedRootIdentity: root.rootIdentity, ...directoryPreimage });
      await client.invoke('main', { operation: 'trash', path: 'relocated', recoveryId: 'captured-tree', expectedRootIdentity: root.rootIdentity, ...directoryPreimage });
      expect(readFileSync(join(vault, 'captured-tree/moved'), 'utf8')).toBe('changed');
      await client.invoke('main', { operation: 'restore', path: 'directory', recoveryId: 'captured-tree', expectedRootIdentity: root.rootIdentity, ...directoryPreimage });
      expect(readFileSync(join(rootPath, 'directory/moved'), 'utf8')).toBe('changed');
      await expect(client.invoke('main', { operation: 'read', path: 'private' })).rejects.toMatchObject({ code: 'NO_CHANGE' });
      const listed = await client.invoke('main', { operation: 'list', path: '.' });
      expect(listed.entries).toEqual([{ name: 'directory', type: 'directory' }]);
      await expect(client.invoke('main', { operation: 'write', path: 'directory/moved', expectedRootIdentity: root.rootIdentity,
        expectedFileIdentity: null, expectedBase64: null, base64: encoded('collision') })).rejects.toMatchObject({ code: 'NEEDS_RECONCILIATION' });
      await expect(client.invoke('main', { operation: 'mkdir', path: 'blocked-after-unknown', expectedRootIdentity: root.rootIdentity }))
        .rejects.toMatchObject({ code: 'NEEDS_RECONCILIATION' });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, 60000);
