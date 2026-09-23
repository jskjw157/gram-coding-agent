import { describe, expect, it, vi } from 'vitest';
import { PathMapper } from './path-mapper.js';

describe('PathMapper', () => {
  it('delegates Linux-to-Windows conversion to injected wslpath runner', async () => {
    const run = vi.fn(async (args: readonly string[]) => {
      expect(args).toEqual(['-w', '/home/johny/.gram-agent/worktrees/84722133/task-id']);
      return 'C:\\Users\\johny\\worktree\r\n';
    });
    const mapper = new PathMapper({ run });

    const result = await mapper.toWindows('/home/johny/.gram-agent/worktrees/84722133/task-id');

    expect(result).toBe('C:\\Users\\johny\\worktree');
    expect(run).toHaveBeenCalledTimes(1);
  });
});
