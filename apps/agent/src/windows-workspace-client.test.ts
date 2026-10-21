import { describe, expect, it, vi } from 'vitest';
import { WindowsWorkspaceClient } from './windows-workspace-client.js';

function fixture() {
  const run = vi.fn(async () => ({ ok: true, kind: 'file', identity: '1:2', bytes: 7, base64: Buffer.from('fixture').toString('base64') }));
  const client = new WindowsWorkspaceClient({
    roots: { 'windows-c': { windowsPath: 'C:\\', writable: true } },
    protectedPaths: ['C:\\GramPrivate'], transport: { run },
  });
  return { client, run };
}
describe('fixed typed native workspace boundary', () => {
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
    await expect(readonly.invoke('drive', { operation: 'mkdir', path: 'new' })).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
  });
  it('screens native errors and rejects malformed replies', async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error('fixture-private-native-path'));
    await expect(f.client.invoke('windows-c', { operation: 'read', path: 'file' })).rejects.toThrow('Native workspace operation denied or failed');
    f.run.mockResolvedValueOnce({ ok: true, kind: 'file', identity: '1:2', bytes: 7, base64: '*bad*' });
    await expect(f.client.invoke('windows-c', { operation: 'read', path: 'file' })).rejects.toThrow();
  });
});
