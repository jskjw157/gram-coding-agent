import { describe, expect, it, vi } from 'vitest';
import { TaskCreateInput, createTaskCreateHandler } from './task-tools.js';

describe('task_create MCP tool', () => {
  it('validates required input and defaults publish mode to pull request', () => {
    expect(TaskCreateInput.safeParse({ repo: '', goal: 'fix it' }).success).toBe(false);
    expect(TaskCreateInput.safeParse({ repo: 'repo', goal: '' }).success).toBe(false);

    const parsed = TaskCreateInput.parse({ repo: 'mamf-web', goal: 'Fix Excel download URL' });
    expect(parsed).toEqual({
      repo: 'mamf-web',
      goal: 'Fix Excel download URL',
      publishMode: 'PULL_REQUEST',
    });
  });

  it('delegates creation to the application port and returns the task view', async () => {
    const create = vi.fn(async () => ({
      id: '0199-uuid',
      displayId: 'TASK-000001',
      repo: 'mamf-web',
      goal: 'Fix Excel download URL',
      status: 'QUEUED' as const,
      publishMode: 'DIRECT_MAIN' as const,
    }));
    const handler = createTaskCreateHandler({ create });

    const result = await handler({
      repo: 'mamf-web',
      goal: 'Fix Excel download URL',
      publishMode: 'DIRECT_MAIN',
    });

    expect(create).toHaveBeenCalledWith({
      repo: 'mamf-web',
      goal: 'Fix Excel download URL',
      publishMode: 'DIRECT_MAIN',
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify(await create.mock.results[0]?.value),
      },
    ]);
  });
});
