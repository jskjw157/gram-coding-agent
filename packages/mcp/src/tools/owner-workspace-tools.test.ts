import type { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import { OwnerWorkspaceInputs, registerOwnerWorkspaceTools, type OwnerWorkspaceToolsPort } from './owner-workspace-tools.js';

describe('owner workspace remote authority boundary', () => {
  it('uses opaque versions and strict narrow inputs rather than caller supplied native authority', () => {
    const write = { root: 'windows-c', path: '.env', expectedVersion: null, content: 'PUBLIC=enabled' };
    expect(OwnerWorkspaceInputs.write.parse(write)).toEqual(write);
    for (const extra of [{ rootPath: 'C:\\' }, { approved: true }, { capability: 'remote approval' },
      { helper: 'powershell.exe' }, { protectedPaths: [] }, { recoveryRoot: 'C:\\' }, { expectedSha256: null }]) {
      expect(OwnerWorkspaceInputs.write.safeParse({ ...write, ...extra }).success).toBe(false);
    }
    expect(OwnerWorkspaceInputs.read.safeParse({ root: 'windows-c', path: '../private' }).success).toBe(false);
    expect(OwnerWorkspaceInputs.read.safeParse({ root: 'windows-c', path: 'src/main.ts', maxLines: 201 }).success).toBe(false);
    expect(OwnerWorkspaceInputs.search.safeParse({ root: 'windows-c', path: '.', term: 'source', cursor: 'caller-state' }).success).toBe(false);
  });
  it('advertises every implemented owner operation without a raw shell or permanent delete', async () => {
    const names: string[] = [];
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const server = { registerTool(name: string, _definition: unknown, handler: (input: unknown) => Promise<unknown>) {
      names.push(name);handlers.set(name, handler);
    } };
    const fail = async () => { throw new Error('private-controller-canary'); };
    const port: OwnerWorkspaceToolsPort = { roots: fail, list: fail, stat: fail, read: fail, search: fail,
      write: fail, patch: fail, mkdir: fail, move: fail, copy: fail, trash: fail, restore: fail,
      readBinary: fail, writeBinary: fail, reveal: fail, convertPath: fail };
    registerOwnerWorkspaceTools(server as unknown as McpServer, port);
    expect(names).toEqual(['local_fs_roots', 'local_fs_list', 'local_fs_stat', 'local_fs_read', 'local_fs_search',
      'local_fs_write', 'local_fs_patch', 'local_fs_mkdir', 'local_fs_move', 'local_fs_copy', 'local_fs_trash',
      'local_fs_restore', 'local_fs_read_binary', 'local_fs_write_binary', 'local_fs_reveal', 'local_fs_convert_path']);
    await expect(handlers.get('local_fs_read')?.({ root: 'windows-c', path: '.env' })).rejects.toThrow('Owner workspace operation denied or failed');
    expect(names).not.toContain('shell');expect(names).not.toContain('local_fs_delete_permanently');
  });
});
