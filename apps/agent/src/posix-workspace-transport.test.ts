import { describe, expect, it } from 'vitest';
import { assertOriginalMountTopology, FixedPosixWorkspaceTransport, PosixWorkspaceClient } from './posix-workspace-transport.js';

const artifact = { path: '/trusted/helper', sha256: '0'.repeat(64) };
const options = { rootPath: '/home/owner/project', recoveryBase: '/home/owner/private-recovery',
  recoveryRoot: { path: '/home/owner/private-vault', identity: '1:2' },
  artifacts: { bubblewrap: artifact, node: artifact, entry: artifact, worker: artifact, native: artifact } };

describe('fixed POSIX filesystem transport', () => {
  it('requires a filesystem-root governing mount and rejects nested mounts with kernel octal escapes', () => {
    const root = '1 0 8:1 / / rw - ext4 /dev/sda rw\n';
    expect(() => assertOriginalMountTopology('/home/owner/project', root)).not.toThrow();
    expect(() => assertOriginalMountTopology('/data', root + '2 1 8:2 / /data rw - ext4 /dev/sdb rw\n')).not.toThrow();
    expect(() => assertOriginalMountTopology('/home/name space', root + '2 1 8:1 /private /home/name\\040space rw - ext4 /dev/sda rw\n')).toThrow();
    expect(() => assertOriginalMountTopology('/home/owner/project', root + '2 1 8:1 /controller /home/owner/project/alias rw - ext4 /dev/sda rw\n')).toThrow();
    expect(() => assertOriginalMountTopology('/home/owner/project', 'malformed')).toThrow();
  });
  it('rejects whole-filesystem root aliases and duplicate additional-volume roots', () => {
    const main = '1 0 8:1 / / rw - ext4 /dev/sda rw\n';
    const alias = '2 1 8:1 / /alias rw - ext4 /dev/sda rw\n';
    expect(() => assertOriginalMountTopology('/alias/home/owner', main + alias)).toThrow();
    expect(() => assertOriginalMountTopology('/home/owner', main + alias)).not.toThrow();
    const volumes = main + '3 1 8:2 / /data rw - ext4 /dev/sdb rw\n' +
      '4 1 8:2 / /data-alias rw - ext4 /dev/sdb rw\n';
    expect(() => assertOriginalMountTopology('/data/project', volumes)).toThrow();
    expect(() => assertOriginalMountTopology('/data-alias/project', volumes)).toThrow();
  });
  it('rejects relative roots, unsafe runtime trees, and invalid pins at configuration time', () => {
    for (const rootPath of ['relative', '/', '/usr', '/proc', '/run', '/dev', '/tmp']) {
      expect(() => new FixedPosixWorkspaceTransport({ ...options, rootPath })).toThrow();
    }
    expect(() => new FixedPosixWorkspaceTransport({ ...options,
      artifacts: { ...options.artifacts, worker: { ...artifact, sha256: 'changed' } } })).toThrow();
  });

  it('denies caller-selected roots and missing trusted artifacts before spawning', async () => {
    const transport = new FixedPosixWorkspaceTransport(options);
    await expect(transport.run({ operation: 'read', root: '/different', path: 'file', protectedPaths: [] }))
      .rejects.toMatchObject({ code: 'NO_CHANGE' });
    await expect(transport.run({ operation: 'mkdir', root: options.rootPath, path: 'new', protectedPaths: [], expectedRootIdentity: '0:0' }))
      .rejects.toMatchObject({ code: 'NO_CHANGE' });
  });

  it('binds client authority to a configured root and strictly validates replies', async () => {
    const client = new PosixWorkspaceClient({ rootId: 'main', rootPath: options.rootPath, writable: true,
      protectedPaths: [], transport: { run: async () => ({ ok: true, rootIdentity: '1:2', kind: 'file', identity: '1:3', bytes: 1, base64: 'eA==' }) } });
    await expect(client.invoke('other', { operation: 'read', path: 'file' })).rejects.toThrow();
    await expect(client.invoke('main', { operation: 'read', path: 'file' })).resolves.toMatchObject({ base64: 'eA==' });
    await expect(client.invoke('main', { operation: 'mkdir', path: 'new', expectedRootIdentity: '9:9' }))
      .rejects.toMatchObject({ code: 'NEEDS_RECONCILIATION' });
  });

});
