import { afterEach, describe, expect, it } from 'vitest';
import {
  CommandRunRepository,
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  VerificationRepository,
} from '@gram/persistence';
import { EvidenceCollector } from './evidence-collector.js';

const databases: Array<{ close(): void }> = [];

function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db);

  new RepositoryRepository(db).upsert({
    githubRepositoryId: 123,
    owner: 'company',
    name: 'web',
    defaultBranch: 'main',
    localBasePath: '/workspace/company/web',
  });
  const task = new TaskRepository(db).create({
    goal: 'verify a change',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId: 123,
  });

  const verification = new VerificationRepository(db);
  const planId = verification.createPlan({
    taskId: task.id,
    headSha: 'a'.repeat(40),
    changeClass: 'FRONTEND_LOGIC',
    plan: { checks: ['lint'] },
  });
  const checkId = verification.createCheck({
    planId,
    taskId: task.id,
    name: 'lint',
    required: true,
  });

  return {
    task,
    verification,
    checkId,
    commands: new CommandRunRepository(db),
    collector: new EvidenceCollector(verification),
  };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

describe('EvidenceCollector', () => {
  it('persists PASS only with a successful command run as evidence', () => {
    const { task, verification, checkId, commands, collector } = setup();
    const commandRunId = commands.start({
      taskId: task.id,
      category: 'VERIFICATION',
      cwd: '/workspace/task',
      shellText: 'pnpm test',
    });
    commands.finish(commandRunId, {
      status: 'SUCCEEDED',
      exitCode: 0,
      stdoutPath: '/logs/stdout.log',
      stderrPath: '/logs/stderr.log',
    });

    collector.recordCommandResult({
      checkId,
      status: 'PASS',
      commandRunId,
    });

    expect(verification.getCheck(checkId)).toMatchObject({
      status: 'PASS',
      commandRunId,
    });
  });

  it('rejects PASS when command evidence points to a failed execution', () => {
    const { task, checkId, commands, collector } = setup();
    const commandRunId = commands.start({
      taskId: task.id,
      category: 'VERIFICATION',
      cwd: '/workspace/task',
      shellText: 'pnpm test',
    });
    commands.finish(commandRunId, {
      status: 'FAILED',
      exitCode: 1,
    });

    expect(() =>
      collector.recordCommandResult({
        checkId,
        status: 'PASS',
        commandRunId,
      }),
    ).toThrow(/successful command evidence/i);
  });

  it('requires explicit evidence for a non-command PASS', () => {
    const { verification, task, collector } = setup();
    const planId = verification.createPlan({
      taskId: task.id,
      changeClass: 'FRONTEND_LOGIC',
      plan: { checks: ['secret-scan'] },
    });
    const checkId = verification.createCheck({
      planId,
      taskId: task.id,
      name: 'secret-scan',
      required: true,
    });

    expect(() =>
      collector.recordNonCommandResult({
        checkId,
        status: 'PASS',
        evidenceRef: '',
      }),
    ).toThrow(/evidence/i);

    collector.recordNonCommandResult({
      checkId,
      status: 'PASS',
      evidenceRef: 'secret-scan:clean',
    });

    expect(verification.getCheck(checkId)).toMatchObject({
      status: 'PASS',
      evidenceRef: 'secret-scan:clean',
    });
  });
});
