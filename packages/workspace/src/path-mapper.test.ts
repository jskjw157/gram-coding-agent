import { describe, expect, it, vi } from 'vitest';
import { PathMapper } from './path-mapper.js';

describe('PathMapper', () => {
  it('delegates Linux-to-Windows conversion to injected wslpath runner', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      expect(args).toEqual(['-w', '/home/johny/.gram-agent/worktrees/84722133/task-id']);
      return 'C:\\Users\\johny\\worktree\r\n';
    });
    const mapper = new PathMapper({ run });

    const result = await mapper.toWindows('/home/johny/.gram-agent/worktrees/84722133/task-id', 'task-id');

    expect(result).toBe('C:\\Users\\johny\\worktree');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('passes task identity into the wslpath conversion seam', async () => {
    const taskId = 'task-123';
    const run = vi.fn(async (args: readonly string[], taskId: string) => {
      void args;
      void taskId;
      return 'C:\\Users\\johny\\worktree\r\n';
    });
    const mapper = new PathMapper({ run });

    const result = await mapper.toWindows('/home/johny/.gram-agent/worktrees/84722133/task-123', taskId);

    expect(result).toBe('C:\\Users\\johny\\worktree');
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[1]).toBe(taskId);
  });
});
