import { describe, expect, it, vi } from 'vitest';
import {
  PullRequestService,
  type PullRequestTaskContext,
} from './pull-request-service.js';

const task: PullRequestTaskContext = {
  taskId: '018d8a73-6b4e-7000-8000-000000000001',
  repoId: 84722133,
  owner: 'company',
  name: 'web',
  headBranch: 'feat/task-000001-fix',
  baseBranch: 'main',
};

describe('PullRequestService.ensureForTask', () => {
  it('reuses an existing open PR for the exact head/base pair and never creates another one', async () => {
    const existing = {
      providerId: 'PR_node_42',
      number: 42,
      url: 'https://github.com/company/web/pull/42',
      headBranch: task.headBranch,
      baseBranch: task.baseBranch,
      state: 'open' as const,
    };
    const client = {
      findOpenPullRequest: vi.fn(async () => existing),
      createPullRequest: vi.fn(),
    };
    const metadata = {
      buildForTask: vi.fn(),
    };
    const persistence = {
      upsertForTask: vi.fn(),
    };
    const service = new PullRequestService({ client, metadata, persistence });

    const result = await service.ensureForTask(task);

    expect(client.findOpenPullRequest).toHaveBeenCalledWith({
      owner: 'company',
      name: 'web',
      headBranch: task.headBranch,
      baseBranch: task.baseBranch,
    });
    expect(client.createPullRequest).not.toHaveBeenCalled();
    expect(metadata.buildForTask).not.toHaveBeenCalled();
    expect(persistence.upsertForTask).toHaveBeenCalledWith({
      taskId: task.taskId,
      repoId: task.repoId,
      ...existing,
    });
    expect(result).toEqual(existing);
  });

  it('does not reuse an open PR whose head/base pair differs', async () => {
    const client = {
      findOpenPullRequest: vi.fn(async () => undefined),
      createPullRequest: vi.fn(async () => ({
        providerId: 'PR_node_43',
        number: 43,
        url: 'https://github.com/company/web/pull/43',
        headBranch: task.headBranch,
        baseBranch: task.baseBranch,
        state: 'open' as const,
      })),
    };
    const metadata = {
      buildForTask: vi.fn(async () => ({
        title: 'Fix verified change',
        body: 'persisted evidence body',
      })),
    };
    const persistence = {
      upsertForTask: vi.fn(),
    };
    const service = new PullRequestService({ client, metadata, persistence });

    await service.ensureForTask(task);

    expect(client.createPullRequest).toHaveBeenCalledTimes(1);
    expect(client.createPullRequest).toHaveBeenCalledWith({
      owner: 'company',
      name: 'web',
      headBranch: task.headBranch,
      baseBranch: task.baseBranch,
      title: 'Fix verified change',
      body: 'persisted evidence body',
    });
  });
});
