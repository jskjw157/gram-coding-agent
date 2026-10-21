import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { LocalDeveloperRunInput, LocalGitDiffInput, LocalGitLogInput, LocalRepositoryInput, registerLocalDeveloperTools, type LocalDeveloperToolsPort } from './local-developer-tools.js';

describe('local developer schemas', () => {
  it('accepts only owner-root relative repository paths', () => {
    expect(LocalRepositoryInput.parse({ root: 'source', path: 'mc-web' })).toEqual({ root: 'source', path: 'mc-web' });
    for (const path of ['../private', '/etc', 'C:/source', 'a\\b', '.git', 'a/../b']) {
      expect(LocalRepositoryInput.safeParse({ root: 'source', path }).success).toBe(false);
    }
  });
  it('does not expose arbitrary command authority', () => {
    expect(LocalDeveloperRunInput.parse({ repositoryId: 1, command: 'test' }).timeoutMs).toBe(60000);
    for (const extra of [{ executable: 'bash' }, { args: ['-c', 'id'] }, { cwd: '/tmp' }, { env: {} }, { category: 'GIT' }]) {
      expect(LocalDeveloperRunInput.safeParse({ repositoryId: 1, command: 'test', ...extra }).success).toBe(false);
    }
    expect(LocalDeveloperRunInput.safeParse({ repositoryId: 1, command: 'install' }).success).toBe(false);
    expect(LocalDeveloperRunInput.safeParse({ repositoryId: 1, command: 'dev', timeoutMs: 900001 }).success).toBe(false);
  });
  it('bounds history and denies option-like or escaping diff paths', () => {
    expect(LocalGitLogInput.parse({ root: 'source', path: '.' }).maxCount).toBe(20);
    expect(LocalGitLogInput.safeParse({ root: 'source', path: '.', maxCount: 101 }).success).toBe(false);
    expect(LocalGitDiffInput.safeParse({ root: 'source', path: '.', relativePath: '--output=/tmp/out' }).success).toBe(false);
  });
  it('registers five narrow tools and suppresses native errors', async () => {
    const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
    const server = { registerTool(name: string, _definition: unknown, handler: (input: unknown) => Promise<unknown>) { handlers.set(name, handler); } };
    const fail = async () => { throw new Error('/private/controller/token'); };
    const port: LocalDeveloperToolsPort = { register: fail, status: fail, diff: fail, log: fail, run: fail };
    registerLocalDeveloperTools(server as unknown as McpServer, port);
    expect([...handlers.keys()]).toEqual(['local_repo_register', 'local_git_status', 'local_git_diff', 'local_git_log', 'local_dev_run']);
    await expect(handlers.get('local_git_status')?.({ root: 'source', path: '.' })).rejects.toThrow('Local developer operation denied or failed');
  });
});
