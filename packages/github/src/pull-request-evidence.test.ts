import { afterEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  PullRequestEvidenceRepository,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  VerificationRepository,
} from '@gram/persistence';

const databases: Array<{ close(): void }> = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('PullRequestEvidenceRepository', () => {
  it('reads task metadata and only the latest persisted verification plan', () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    runMigrations(db);

    new RepositoryRepository(db).upsert({
      githubRepositoryId: 84722133,
      owner: 'company',
      name: 'web',
      defaultBranch: 'main',
      localBasePath: '/workspace/company/web',
    });
    const task = new TaskRepository(db).create({
      goal: 'Fix profile cache',
      taskType: 'CODING',
      publishMode: 'PULL_REQUEST',
      repoId: 84722133,
      metadata: {
        summary: 'Fix profile cache invalidation',
        rootCause: 'Previous cache key survived mutation.',
        changedPaths: ['src/cache.ts', 'src/profile.ts'],
      },
    });

    const verification = new VerificationRepository(db);
    const oldPlan = verification.createPlan({
      taskId: task.id,
      changeClass: 'FRONTEND_LOGIC',
      plan: {},
    });
    verification.createCheck({
      planId: oldPlan,
      taskId: task.id,
      name: 'old-check',
      required: true,
      status: 'SKIPPED',
    });

    const plan = verification.createPlan({
      taskId: task.id,
      changeClass: 'FRONTEND_LOGIC',
      plan: {},
    });
    const lint = verification.createCheck({
      planId: plan,
      taskId: task.id,
      name: 'lint',
      required: true,
    });
    verification.finishCheck(lint, {
      status: 'PASS',
      evidenceRef: 'lint:verified',
    });
    const test = verification.createCheck({
      planId: plan,
      taskId: task.id,
      name: 'test',
      required: true,
    });
    verification.finishCheck(test, {
      status: 'FAIL',
      evidenceRef: 'test:failed',
    });

    const evidence = new PullRequestEvidenceRepository(db).readForTask(task.id);

    expect(evidence).toMatchObject({
      taskId: task.id,
      summary: 'Fix profile cache invalidation',
      rootCause: 'Previous cache key survived mutation.',
      changedPaths: ['src/cache.ts', 'src/profile.ts'],
      verification: [
        { name: 'lint', required: true, status: 'PASS', hasEvidence: true },
        { name: 'test', required: true, status: 'FAIL', hasEvidence: true },
      ],
    });
    expect(evidence.verification.some((check) => check.name === 'old-check')).toBe(false);
  });
});
