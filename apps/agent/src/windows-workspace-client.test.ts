import { describe, expect, it, vi } from 'vitest';
import { NativeWorkspaceDeniedError, NativeWorkspaceUnresolvedError, parseNativeWorkspaceReply, WindowsWorkspaceClient } from './windows-workspace-client.js';

function fixture() {
  const run = vi.fn(async () => ({ ok: true, rootIdentity: '1:1', kind: 'file', identity: '1:2', bytes: 7, base64: Buffer.from('fixture').toString('base64') }));
  const client = new WindowsWorkspaceClient({
    roots: { 'windows-c': { windowsPath: 'C:\\', writable: true } },
    protectedPaths: ['C:\\GramPrivate'], transport: { run },
  });
  return { client, run };
}
describe('fixed typed native workspace boundary', () => {
  it('preserves optional boolean list completeness metadata and legacy replies', () => {
    const listing = { ok: true, rootIdentity: '1:1', entries: [] };
    expect(parseNativeWorkspaceReply(listing, 'list')).toEqual(listing);
    for (const omitted of [true, false]) {
      expect(parseNativeWorkspaceReply({ ...listing, omitted }, 'list')).toEqual({ ...listing, omitted });
    }
  });
  it('rejects non-boolean completeness metadata and metadata on other operations', () => {
    for (const omitted of [undefined, null, 0, 1, 'false', [], {}]) {
      expect(() => parseNativeWorkspaceReply({ ok: true, rootIdentity: '1:1', entries: [], omitted }, 'list')).toThrow();
    }
    expect(() => parseNativeWorkspaceReply({ ok: true, rootIdentity: '1:1', kind: 'directory', identity: '1:2', omitted: false }, 'stat')).toThrow();
  });
  it('preserves proven no-change denials instead of quarantining harmless conflicts', async () => {
    const client = new WindowsWorkspaceClient({ roots: { drive: { windowsPath: 'C:\\', writable: true } },
      protectedPaths: ['C:\\private'], transport: { run: async () => { throw new NativeWorkspaceDeniedError(); } } });
    await expect(client.invoke('drive', { operation: 'mkdir', path: 'occupied', expectedRootIdentity: '1:1' }))
      .rejects.toBeInstanceOf(NativeWorkspaceDeniedError);
  });
  it('selects root and protected paths only from trusted configuration', async () => {
    const f = fixture();
    await f.client.invoke('windows-c', { operation: 'read', path: 'source/fixture.txt' });
    expect(f.run).toHaveBeenCalledWith({ operation: 'read', root: 'C:\\', path: 'source/fixture.txt', protectedPaths: ['C:\\GramPrivate'] });
    await expect(f.client.invoke('windows-c', { operation: 'read', path: 'source/fixture.txt', root: 'D:\\' } as never)).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(1);
  });
  it('denies traversal, unknown operations, unknown roots and writes in read-only roots', async () => {
    const f = fixture();
    for (const operation of [{ operation: 'exec', path: '.', executable: 'cmd.exe' },
      { operation: 'read', path: '../private' }, { operation: 'read', path: 'file:stream' }]) {
      await expect(f.client.invoke('windows-c', operation as never)).rejects.toThrow();
    }
    await expect(f.client.invoke('missing', { operation: 'read', path: 'file' })).rejects.toThrow();
    const readonly = new WindowsWorkspaceClient({ roots: { drive: { windowsPath: 'D:\\', writable: false } }, protectedPaths: [], transport: { run: f.run } });
    await expect(readonly.invoke('drive', { operation: 'mkdir', path: 'new', expectedRootIdentity: '1:1' })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('screens native errors and rejects malformed replies', async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error('fixture-private-native-path'));
    await expect(f.client.invoke('windows-c', { operation: 'read', path: 'file' })).rejects.toThrow('Native workspace operation denied or failed');
    f.run.mockResolvedValueOnce({ ok: true, rootIdentity: '1:1', kind: 'file', identity: '1:2', bytes: 7, base64: '*bad*' });
    await expect(f.client.invoke('windows-c', { operation: 'read', path: 'file' })).rejects.toThrow();
  });
  it('preserves an unresolved mutation outcome for the durable journal instead of reporting a simple denial', async () => {
    const f = fixture();f.run.mockRejectedValueOnce(new NativeWorkspaceUnresolvedError());
    await expect(f.client.invoke('windows-c', { operation: 'write', path: 'new', expectedBase64: null,
      base64: Buffer.from('fixture').toString('base64'), expectedRootIdentity: '1:1', expectedFileIdentity: null }))
      .rejects.toBeInstanceOf(NativeWorkspaceUnresolvedError);
  });
});



describe('fixed native Git pack chunk admission', () => {
  const path = '.git/objects/pack/pack-' + 'a'.repeat(40) + '.pack';
  const valid = {
    ok: true, rootIdentity: '1:1', kind: 'file', identity: '1:4',
    bytes: 4, base64: Buffer.from('PACK').toString('base64'), totalBytes: 1048580,
    gitStamp: '1:4:1048580:0:4',
  };
  it('admits only bounded Git pack frames, not ordinary files or arbitrary read APIs', async () => {
    const run = vi.fn(async () => valid);
    const client = new WindowsWorkspaceClient({ roots: { c: { windowsPath: 'C:\\', writable: false } },
      protectedPaths: [], transport: { run } });
    const result = await client.invoke('c', { operation: 'readGitChunk', path, offset: 0, length: 4 });
    expect(result).toMatchObject({ base64: valid.base64, gitStamp: valid.gitStamp, totalBytes: 1048580 });
    expect(run).toHaveBeenCalledWith({ operation: 'readGitChunk', path, offset: 0, length: 4,
      root: 'C:\\', protectedPaths: [] });
    for (const invalid of [
      { path: 'private.txt' }, { path: '.git/objects/pack/foo.pack' },
      { offset: -1 }, { length: 262145 }, { offset: 67108864 }, { length: 0 },
      { path: '.git/objects/pack/pack-' + 'a'.repeat(40) + '.pack:ads' },
    ]) {
      await expect(client.invoke('c', { operation: 'readGitChunk', path, offset: 0, length: 4, ...invalid }))
        .rejects.toThrow();
    }
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('denies malformed chunks and refuses untrusted extra reply fields', async () => {
    for (const mutation of [
      { bytes: 500000 }, { totalBytes: 67108865 }, { gitStamp: 'bad' },
      { unexpectedNativePath: 'C:\\private' }, { base64: '*' },
    ]) {
      const client = new WindowsWorkspaceClient({ roots: { c: { windowsPath: 'C:\\', writable: false } },
        protectedPaths: [], transport: { run: async () => ({ ...valid, ...mutation }) } });
      await expect(client.invoke('c', { operation: 'readGitChunk', path, offset: 0, length: 4 }))
        .rejects.toThrow();
    }
  });
});

describe('native directory and recovery protocol', () => {
  function recoveryFixture() {
    const run = vi.fn(async (): Promise<unknown> => ({ ok: true, rootIdentity: '1:1' }));
    const client = new WindowsWorkspaceClient({
      roots: { drive: { windowsPath: 'C:\\', writable: true } }, protectedPaths: ['C:\\private'],
      recoveryRoots: { drive: { windowsPath: 'C:\\private\\Recovery', identity: '1:90' } }, transport: { run },
    });
    return { client, run };
  }
  const directory = { expectedKind: 'directory' as const, expectedVersion: 'a'.repeat(64),
    expectedRootIdentity: '1:1', expectedFileIdentity: '1:2' };
  it('validates a bounded directory manifest and directory move shape', async () => {
    const f = recoveryFixture();
    f.run.mockResolvedValueOnce({ ok: true, rootIdentity: '1:1', kind: 'directory', identity: '1:2', version: 'a'.repeat(64) });
    expect((await f.client.invoke('drive', { operation: 'treeStat', path: 'tree' })).version).toBe('a'.repeat(64));
    await f.client.invoke('drive', { operation: 'move', path: 'tree', destination: 'moved', ...directory });
    for (const fields of [{ expectedVersion: '*' }, { expectedVersion: undefined }, { expectedBase64: '' }, { destination: '../outside' }]) {
      await expect(f.client.invoke('drive', { operation: 'move', path: 'tree', destination: 'moved', ...directory, ...fields } as never)).rejects.toThrow();
    }
    expect(f.run).toHaveBeenCalledTimes(2);
    f.run.mockResolvedValueOnce({ ok: true, rootIdentity: '1:1', kind: 'directory', identity: '1:2', version: 'a'.repeat(64), base64: '' });
    await expect(f.client.invoke('drive', { operation: 'treeStat', path: 'tree' })).rejects.toThrow();
  });
  it('injects vault identity and path only from immutable trusted configuration', async () => {
    const run = vi.fn(async (): Promise<unknown> => ({ ok: true, rootIdentity: '1:1' }));
    const vault = { windowsPath: 'C:\\private\\Recovery', identity: '1:90' };
    const options = { roots: { drive: { windowsPath: 'C:\\', writable: true } },
      protectedPaths: ['C:\\private'], recoveryRoots: { drive: vault }, transport: { run } };
    const client = new WindowsWorkspaceClient(options);
    vault.windowsPath = 'D:\\public';vault.identity = '2:0';
    const operation = { operation: 'trash' as const, path: 'tree', recoveryId: 'controller-generated', ...directory };
    await client.invoke('drive', operation);
    expect(run).toHaveBeenCalledWith({ ...operation, root: 'C:\\', protectedPaths: ['C:\\private', 'C:\\private\\Recovery'],
      recoveryRoot: 'C:\\private\\Recovery', expectedRecoveryRootIdentity: '1:90' });
    for (const injected of [{ recoveryRoot: 'D:\\public' }, { expectedRecoveryRootIdentity: '2:0' }, { recoveryId: '../escape' }, { recoveryId: 'two/segments' }]) {
      await expect(client.invoke('drive', { ...operation, ...injected } as never)).rejects.toThrow();
    }
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('requires typed file recovery preimages and rejects malformed vault configuration', async () => {
    const f = recoveryFixture();
    const file = { operation: 'trash' as const, path: 'file', recoveryId: 'record', expectedKind: 'file' as const,
      expectedBase64: Buffer.from('preimage').toString('base64'), expectedRootIdentity: '1:1', expectedFileIdentity: '1:2' };
    await f.client.invoke('drive', file);
    await f.client.invoke('drive', { ...file, operation: 'restore' });
    for (const changed of [{ expectedKind: undefined }, { expectedBase64: '*' }, { expectedVersion: 'a'.repeat(64) }]) {
      await expect(f.client.invoke('drive', { ...file, ...changed } as never)).rejects.toThrow();
    }
    expect(f.run).toHaveBeenCalledTimes(2);
    for (const recoveryRoots of [{ missing: { windowsPath: 'C:\\private', identity: '1:90' } },
      { drive: { windowsPath: 'relative', identity: '1:90' } }, { drive: { windowsPath: 'C:\\private', identity: 'invalid' } }]) {
      expect(() => new WindowsWorkspaceClient({ roots: { drive: { windowsPath: 'C:\\', writable: true } },
        protectedPaths: ['C:\\private'], recoveryRoots, transport: { run: f.run } })).toThrow();
    }
  });
  it('rejects recovery without a configured vault and keeps malformed or unbound mutation replies unresolved', async () => {
    const f = recoveryFixture();
    const operation = { operation: 'restore' as const, path: 'restored', recoveryId: 'record', ...directory };
    for (const response of [{ ok: true, rootIdentity: '2:2' }, { ok: true, rootIdentity: '1:1', recoveryId: 'surprise' }]) {
      f.run.mockResolvedValueOnce(response);
      await expect(f.client.invoke('drive', operation)).rejects.toBeInstanceOf(NativeWorkspaceUnresolvedError);
    }
    const missing = fixture();
    await expect(missing.client.invoke('windows-c', operation)).rejects.toThrow();
    expect(missing.run).not.toHaveBeenCalled();
    const readonly = new WindowsWorkspaceClient({ roots: { drive: { windowsPath: 'C:\\', writable: false } },
      protectedPaths: [], recoveryRoots: { drive: { windowsPath: 'C:\\private', identity: '1:90' } }, transport: { run: f.run } });
    await expect(readonly.invoke('drive', operation)).rejects.toThrow();
    expect(f.run).toHaveBeenCalledTimes(2);
  });
});
