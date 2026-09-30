import { describe, expect, it } from 'vitest';
import { RemoteService } from './remote-service.js';

describe('immutable published Git commit', () => {
  it('pushes the verified SHA rather than mutable HEAD when supplied', async () => {
    const calls: string[][] = [];
    const remote = new RemoteService({ run: async (request) => {
      calls.push([...(request.args ?? [])]);
      return { exitCode: 0, stdout: '', stderr: '' };
    } }, { taskId: 'task-158' }, '/worktree');
    const sha = 'a'.repeat(40);
    await remote.push('/worktree', 'feat/task-158', sha);
    expect(calls).toEqual([['push', 'origin', `${sha}:refs/heads/feat/task-158`]]);
  });
  it('rejects invalid supplied SHAs before running Git', async () => {
    let calls = 0;
    const remote = new RemoteService({ run: async () => {
      calls++; return { exitCode: 0, stdout: '', stderr: '' };
    } }, { taskId: 'task-158' }, '/worktree');
    await expect(remote.push('/worktree', 'feat/task-158', 'HEAD')).rejects.toThrow(/SHA/i);
    expect(calls).toBe(0);
  });
});
