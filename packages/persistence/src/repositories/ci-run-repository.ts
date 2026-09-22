import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export interface UpsertCiCheckInput {
  taskId: TaskId;
  pullRequestId?: number | null;
  providerRunId?: string | null;
  providerCheckId: string;
  workflowName?: string | null;
  checkName: string;
  status: string;
  conclusion?: string | null;
  url?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  updatedAt?: string;
}

export interface StoredCiRun {
  id: number;
  taskId: TaskId;
  pullRequestId: number | null;
  providerRunId: string | null;
  providerCheckId: string;
  workflowName: string | null;
  checkName: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

interface CiRunRow {
  id: number;
  task_id: TaskId;
  pull_request_id: number | null;
  provider_run_id: string | null;
  provider_check_id: string | null;
  workflow_name: string | null;
  check_name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

function decode(row: CiRunRow): StoredCiRun {
  if (row.provider_check_id === null) {
    throw new Error(`CI row ${row.id} is missing provider_check_id`);
  }
  return {
    id: row.id,
    taskId: row.task_id,
    pullRequestId: row.pull_request_id,
    providerRunId: row.provider_run_id,
    providerCheckId: row.provider_check_id,
    workflowName: row.workflow_name,
    checkName: row.check_name,
    status: row.status,
    conclusion: row.conclusion,
    url: row.url,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export class CiRunRepository {
  constructor(private readonly db: Database.Database) {}

  upsertCheck(input: UpsertCiCheckInput): StoredCiRun {
    const providerCheckId = input.providerCheckId.trim();
    if (providerCheckId.length === 0) {
      throw new Error('providerCheckId must not be empty');
    }
    if (input.checkName.trim().length === 0) {
      throw new Error('checkName must not be empty');
    }

    const updatedAt = input.updatedAt ?? new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const existing = this.db
        .prepare(
          'SELECT id FROM ci_runs WHERE task_id = ? AND provider_check_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(input.taskId, providerCheckId) as { id: number } | undefined;

      if (existing === undefined) {
        const result = this.db
          .prepare(`
            INSERT INTO ci_runs(
              task_id, pull_request_id, provider_run_id, provider_check_id,
              workflow_name, check_name, status, conclusion, url,
              started_at, finished_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            input.taskId,
            input.pullRequestId ?? null,
            input.providerRunId ?? null,
            providerCheckId,
            input.workflowName ?? null,
            input.checkName,
            input.status,
            input.conclusion ?? null,
            input.url ?? null,
            input.startedAt ?? null,
            input.finishedAt ?? null,
            updatedAt,
          );
        return Number(result.lastInsertRowid);
      }

      this.db
        .prepare(`
          UPDATE ci_runs
          SET pull_request_id = ?,
              provider_run_id = ?,
              workflow_name = ?,
              check_name = ?,
              status = ?,
              conclusion = ?,
              url = ?,
              started_at = ?,
              finished_at = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          input.pullRequestId ?? null,
          input.providerRunId ?? null,
          input.workflowName ?? null,
          input.checkName,
          input.status,
          input.conclusion ?? null,
          input.url ?? null,
          input.startedAt ?? null,
          input.finishedAt ?? null,
          updatedAt,
          existing.id,
        );
      return existing.id;
    });

    const id = transaction.immediate();
    const stored = this.get(id);
    if (stored === undefined) throw new Error('CI check row was not persisted');
    return stored;
  }

  get(id: number): StoredCiRun | undefined {
    const row = this.db
      .prepare('SELECT * FROM ci_runs WHERE id = ?')
      .get(id) as CiRunRow | undefined;
    return row === undefined ? undefined : decode(row);
  }

  listForTask(taskId: TaskId): StoredCiRun[] {
    const rows = this.db
      .prepare('SELECT * FROM ci_runs WHERE task_id = ? ORDER BY id')
      .all(taskId) as CiRunRow[];
    return rows.map(decode);
  }
}
