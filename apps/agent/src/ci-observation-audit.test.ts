import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChecksClientPort, RequiredCheckSnapshot } from '@gram/github';
import {
  AuditRepository,
  CiRunRepository,
  openDatabase,
  PullRequestRepository,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
} from '@gram/persistence';
import { createTaskRunner } from './task-runner-composition.js';

const FIRST_TIME = '2026-10-07T02:00:00.000Z';
const SECOND_TIME = '2026-10-07T02:00:05.000Z';
const SHA = 'a'.repeat(40);
const REPAIRED_SHA = 'b'.repeat(40);
const REPO_ID = 770001;

interface ObservationRow {
  id: number;
  taskId: string;
  createdAt: string;
  payloadJson: string;
}

function successCheck(): RequiredCheckSnapshot {
  return {
    providerCheckId: '77',
    checkName: 'verify',
    status: 'completed',
    conclusion: 'success',
    startedAt: '2020-01-01T00:00:00.000Z',
  };
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-ci-observation-'));
  const path = join(root, 'agent.sqlite');
  let database = openDatabase(path);
  runMigrations(database);
  new RepositoryRepository(database).upsert({
    githubRepositoryId: REPO_ID,
    owner: 'acme',
    name: 'smoke',
    defaultBranch: 'main',
    localBasePath: join(root, 'canonical'),
  });
  const task = new TaskRepository(database).create({
    goal: 'Record CI observation evidence',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId: REPO_ID,
  });
  const pr = new PullRequestRepository(database).upsertForTask({
    taskId: task.id,
    repoId: REPO_ID,
    number: 7,
    url: 'https://github.com/acme/smoke/pull/7',
    headBranch: 'fix/smoke',
    baseBranch: 'main',
    state: 'open',
  });

  function observations(connection = database): ObservationRow[] {
    return connection.prepare(`
      SELECT id, task_id AS taskId, created_at AS createdAt, payload_json AS payloadJson
      FROM audit_events WHERE event_type = 'CI_OBSERVATION_STARTED' ORDER BY id
    `).all() as ObservationRow[];
  }

  return {
    task,
    pr,
    observations,
    independentlyReadObservations() {
      const reader = openDatabase(path);
      try {
        return observations(reader);
      } finally {
        reader.close();
      }
    },
    ciRuns: () => new CiRunRepository(database).listForTask(task.id),
    reopen() {
      database.close();
      database = openDatabase(path);
    },
    rejectObservationWrites() {
      database.exec(`
        CREATE TRIGGER reject_ci_observation BEFORE INSERT ON audit_events
        WHEN NEW.event_type = 'CI_OBSERVATION_STARTED'
        BEGIN SELECT RAISE(ABORT, 'CI audit unavailable'); END;
      `);
    },
    observe(client: ChecksClientPort, headSha = SHA) {
      // Exercise the real repair composition and SQLite boundaries; repository
      // mutation ports are fixture-only doubles and perform no external work.
      const runner = createTaskRunner({
        tasks: new TaskRepository(database),
        audit: new AuditRepository(database),
        locks: { acquire: async () => ({ release: async () => undefined }) },
        workspaces: { getByTaskId: () => ({ linuxPath: join(root, 'worktree'), branch: 'fix/smoke' }) },
        capabilities: { repairMutations: { repair: async () => undefined } },
        verification: { requiredChecksPassed: () => true },
        remote: { push: async () => headSha, confirmRemoteSha: async () => true },
        checks: {
          client,
          persistence: new CiRunRepository(database),
          delay: { wait: async () => undefined },
          maxAttempts: 2,
          pollIntervalMs: 0,
        },
        ciContext: { resolve: async () => ({
          taskId: task.id,
          pullRequestId: pr.id,
          owner: 'acme',
          name: 'smoke',
          number: 7,
          headSha,
          baseBranch: 'main',
        }) },
      });
      return runner.runRepairCycle({
        taskId: task.id,
        repoId: REPO_ID,
        branch: 'fix/smoke',
        remote: 'origin',
        ciOutcome: 'FAILURE',
      });
    },
    cleanup() {
      if (database.open) database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('durable local CI observation evidence', () => {
  it.each(['pending', 'empty'] as const)(
    'persists before every provider call after %s, and preserves the first timestamp after reopen',
    async (firstResult) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(FIRST_TIME);
      const fixture = createFixture();
      try {
        let calls = 0;
        const result = await fixture.observe({
          listRequiredChecks: async () => {
            calls += 1;
            // A second connection proves the write is committed before the
            // provider starts, rather than remaining in an open transaction.
            const rows = fixture.independentlyReadObservations();
            expect(rows).toHaveLength(calls);
            expect(rows[0]?.createdAt).toBe(FIRST_TIME);
            expect(rows.every((row) => row.taskId === fixture.task.id)).toBe(true);
            expect(JSON.parse(rows.at(-1)?.payloadJson ?? 'null')).toEqual({
              pullRequestId: fixture.pr.id,
              headSha: SHA,
            });
            if (calls === 1) {
              vi.setSystemTime(SECOND_TIME);
              return firstResult === 'empty' ? [] : [{ ...successCheck(), status: 'in_progress', conclusion: null }];
            }
            return [successCheck()];
          },
        });
        expect(result.ciOutcome).toBe('SUCCESS');
        const originalRows = fixture.observations();
        expect(originalRows.map((row) => row.createdAt)).toEqual([FIRST_TIME, SECOND_TIME]);
        expect(fixture.ciRuns()[0]?.updatedAt).toBe(SECOND_TIME);
        expect(fixture.ciRuns()[0]?.startedAt).toBe('2020-01-01T00:00:00.000Z');

        fixture.reopen();
        expect(fixture.observations()).toEqual(originalRows);
        await fixture.observe({ listRequiredChecks: async () => [successCheck()] }, REPAIRED_SHA);
        const resumedRows = fixture.observations();
        expect(resumedRows.slice(0, 2)).toEqual(originalRows);
        expect(JSON.parse(resumedRows[2]?.payloadJson ?? 'null')).toEqual({
          pullRequestId: fixture.pr.id,
          headSha: REPAIRED_SHA,
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it('retains the observation attempt when the provider fails without recording check success', async () => {
    const fixture = createFixture();
    try {
      await expect(fixture.observe({
        listRequiredChecks: async () => { throw new Error('provider unavailable'); },
      })).rejects.toThrow('provider unavailable');
      fixture.reopen();
      expect(fixture.observations()).toHaveLength(1);
      expect(fixture.ciRuns()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it('fails before contacting the provider when the audit write cannot commit', async () => {
    const fixture = createFixture();
    try {
      fixture.rejectObservationWrites();
      let providerCalled = false;
      await expect(fixture.observe({
        listRequiredChecks: async () => {
          providerCalled = true;
          return [successCheck()];
        },
      })).rejects.toThrow('CI audit unavailable');
      expect(providerCalled).toBe(false);
      expect(fixture.ciRuns()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
