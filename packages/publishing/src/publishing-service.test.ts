import { describe, expect, it, vi } from 'vitest';
import {
  PublishingService,
  RemotePushConfirmationError,
  type PublishingTaskContext,
} from './publishing-service.js';

const taskId = '018d8a73-6b4e-7000-8000-000000000001';
const sha = 'a'.repeat(40);

function context(overrides: Partial<PublishingTaskContext> = {}): PublishingTaskContext {
  return {
    taskId,
    repoId: 84722133,
    worktree: '/home/user/.gram-agent/worktrees/84722133/task',
    branch: 'feat/task-000001-publish',
    paths: ['src/app.ts'],
    commitMessage: 'feat: publish verified change',
    remote: 'origin',
    lock: {
      release: vi.fn(async () => undefined),
    },
    ...overrides,
  };
}

describe('PublishingService critical lock boundary', () => {
  it('does not release the Repo Lock when exact remote confirmation fails', async () => {
    const events: string[] = [];
    const lock = {
      release: vi.fn(async () => {
        events.push('lock.release');
      }),
    };
    const markRemoteConfirmed = vi.fn();
    const service = new PublishingService({
      verification: {
        assertPassed: vi.fn(async () => {
          events.push('verification.assertPassed');
        }),
      },
      commits: {
        commitExplicit: vi.fn(async () => {
          events.push('commit');
          return sha;
        }),
      },
      remote: {
        push: vi.fn(async () => {
          events.push('push');
        }),
        confirmRemoteSha: vi.fn(async () => {
          events.push('remote.confirm');
          return false;
        }),
      },
      persistence: {
        recordCommit: vi.fn(() => 41),
        markRemoteConfirmed,
      },
      audit: {
        append: vi.fn(),
      },
    });

    await expect(service.publish(context({ lock }))).rejects.toBeInstanceOf(
      RemotePushConfirmationError,
    );

    expect(events).toEqual([
      'verification.assertPassed',
      'commit',
      'push',
      'remote.confirm',
    ]);
    expect(lock.release).not.toHaveBeenCalled();
    expect(markRemoteConfirmed).not.toHaveBeenCalled();
  });

  it('releases the Repo Lock only after verification, commit, push, and exact remote confirmation', async () => {
    const events: string[] = [];
    const lock = {
      release: vi.fn(async () => {
        events.push('lock.release');
      }),
    };
    const service = new PublishingService({
      verification: {
        assertPassed: vi.fn(async () => {
          events.push('verification.assertPassed');
        }),
      },
      commits: {
        commitExplicit: vi.fn(async () => {
          events.push('commit');
          return sha;
        }),
      },
      remote: {
        push: vi.fn(async () => {
          events.push('push');
        }),
        confirmRemoteSha: vi.fn(async () => {
          events.push('remote.confirm');
          return true;
        }),
      },
      persistence: {
        recordCommit: vi.fn(() => 41),
        markRemoteConfirmed: vi.fn(),
      },
      audit: {
        append: vi.fn(),
      },
    });

    const published = await service.publish(context({ lock }));

    expect(events).toEqual([
      'verification.assertPassed',
      'commit',
      'push',
      'remote.confirm',
      'lock.release',
    ]);
    expect(published).toMatchObject({
      commitId: 41,
      taskId,
      repoId: 84722133,
      sha,
      branch: 'feat/task-000001-publish',
      remote: 'origin',
    });
  });

  it('does not mutate Git or release the lock when verification has not passed', async () => {
    const commits = {
      commitExplicit: vi.fn(async () => sha),
    };
    const remote = {
      push: vi.fn(async () => undefined),
      confirmRemoteSha: vi.fn(async () => true),
    };
    const lock = {
      release: vi.fn(async () => undefined),
    };
    const persistence = {
      recordCommit: vi.fn(() => 41),
      markRemoteConfirmed: vi.fn(),
    };
    const service = new PublishingService({
      verification: {
        assertPassed: vi.fn(async () => {
          throw new Error('required verification has not passed');
        }),
      },
      commits,
      remote,
      persistence,
      audit: { append: vi.fn() },
    });

    await expect(service.publish(context({ lock }))).rejects.toThrow(
      /verification has not passed/i,
    );

    expect(commits.commitExplicit).not.toHaveBeenCalled();
    expect(remote.push).not.toHaveBeenCalled();
    expect(remote.confirmRemoteSha).not.toHaveBeenCalled();
    expect(persistence.recordCommit).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('does not confirm or release when push itself fails', async () => {
    const lock = {
      release: vi.fn(async () => undefined),
    };
    const confirmRemoteSha = vi.fn(async () => true);
    const markRemoteConfirmed = vi.fn();
    const service = new PublishingService({
      verification: {
        assertPassed: vi.fn(async () => undefined),
      },
      commits: {
        commitExplicit: vi.fn(async () => sha),
      },
      remote: {
        push: vi.fn(async () => {
          throw new Error('push failed');
        }),
        confirmRemoteSha,
      },
      persistence: {
        recordCommit: vi.fn(() => 41),
        markRemoteConfirmed,
      },
      audit: { append: vi.fn() },
    });

    await expect(service.publish(context({ lock }))).rejects.toThrow(/push failed/i);

    expect(confirmRemoteSha).not.toHaveBeenCalled();
    expect(markRemoteConfirmed).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it('persists and audits confirmation before releasing mutation control', async () => {
    const events: string[] = [];
    const service = new PublishingService({
      verification: {
        assertPassed: vi.fn(async () => {
          events.push('verification.assertPassed');
        }),
      },
      commits: {
        commitExplicit: vi.fn(async () => {
          events.push('commit');
          return sha;
        }),
      },
      remote: {
        push: vi.fn(async () => {
          events.push('push');
        }),
        confirmRemoteSha: vi.fn(async () => {
          events.push('remote.confirm');
          return true;
        }),
      },
      persistence: {
        recordCommit: vi.fn(() => {
          events.push('persistence.recordCommit');
          return 41;
        }),
        markRemoteConfirmed: vi.fn(() => {
          events.push('persistence.markRemoteConfirmed');
        }),
      },
      audit: {
        append: vi.fn((event: { eventType: string }) => {
          events.push(`audit.${event.eventType}`);
        }),
      },
      now: () => new Date('2026-09-22T01:00:00.000Z'),
    });
    const lock = {
      release: vi.fn(async () => {
        events.push('lock.release');
      }),
    };

    await service.publish(context({ lock }));

    expect(events).toEqual([
      'verification.assertPassed',
      'commit',
      'persistence.recordCommit',
      'audit.COMMIT_CREATED',
      'audit.PUSH_STARTED',
      'push',
      'remote.confirm',
      'persistence.markRemoteConfirmed',
      'audit.REMOTE_PUSH_CONFIRMED',
      'lock.release',
      'audit.REPO_LOCK_RELEASED',
    ]);
  });
});
