import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export type StoredVerificationCheckStatus =
  | 'PENDING'
  | 'PASS'
  | 'FAIL'
  | 'SKIPPED'
  | 'NOT_REQUIRED';

export interface CreateVerificationPlanInput {
  taskId: TaskId;
  headSha?: string | null;
  changeClass: string;
  risk?: string | null;
  plan: unknown;
  createdAt?: string;
}

export interface CreateVerificationCheckInput {
  planId: number;
  taskId: TaskId;
  name: string;
  required: boolean;
  status?: StoredVerificationCheckStatus;
  reason?: string | null;
}

export interface FinishVerificationCheckInput {
  status: Exclude<StoredVerificationCheckStatus, 'PENDING'>;
  commandRunId?: number | null;
  evidenceRef?: string | null;
  reason?: string | null;
  startedAt?: string | null;
  finishedAt?: string;
}

export interface StoredVerificationCheck {
  id: number;
  planId: number;
  taskId: TaskId;
  name: string;
  required: boolean;
  status: StoredVerificationCheckStatus;
  commandRunId: number | null;
  evidenceRef: string | null;
  reason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  hasEvidence: boolean;
}

interface VerificationCheckRow {
  id: number;
  plan_id: number;
  task_id: TaskId;
  name: string;
  required: number;
  status: StoredVerificationCheckStatus;
  command_run_id: number | null;
  evidence_ref: string | null;
  reason: string | null;
  started_at: string | null;
  finished_at: string | null;
}

function decodeCheck(row: VerificationCheckRow): StoredVerificationCheck {
  return {
    id: row.id,
    planId: row.plan_id,
    taskId: row.task_id,
    name: row.name,
    required: row.required === 1,
    status: row.status,
    commandRunId: row.command_run_id,
    evidenceRef: row.evidence_ref,
    reason: row.reason,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    hasEvidence:
      row.command_run_id !== null ||
      (row.evidence_ref !== null && row.evidence_ref.trim().length > 0),
  };
}

export class VerificationRepository {
  constructor(private readonly db: Database.Database) {}

  createPlan(input: CreateVerificationPlanInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO verification_plans(
          task_id, head_sha, change_class, risk, plan_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.taskId,
        input.headSha ?? null,
        input.changeClass,
        input.risk ?? null,
        JSON.stringify(input.plan),
        input.createdAt ?? new Date().toISOString(),
      );
    return Number(result.lastInsertRowid);
  }

  createCheck(input: CreateVerificationCheckInput): number {
    const result = this.db
      .prepare(`
        INSERT INTO verification_checks(
          plan_id, task_id, name, required, status, reason
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.planId,
        input.taskId,
        input.name,
        input.required ? 1 : 0,
        input.status ?? 'PENDING',
        input.reason ?? null,
      );
    return Number(result.lastInsertRowid);
  }

  getCheck(id: number): StoredVerificationCheck | undefined {
    const row = this.db
      .prepare('SELECT * FROM verification_checks WHERE id = ?')
      .get(id) as VerificationCheckRow | undefined;
    return row === undefined ? undefined : decodeCheck(row);
  }

  listForTask(taskId: TaskId): StoredVerificationCheck[] {
    const rows = this.db
      .prepare(`
        SELECT *
        FROM verification_checks
        WHERE task_id = ?
          AND plan_id = (
            SELECT id
            FROM verification_plans
            WHERE task_id = ?
            ORDER BY id DESC
            LIMIT 1
          )
        ORDER BY id
      `)
      .all(taskId, taskId) as VerificationCheckRow[];
    return rows.map(decodeCheck);
  }

  finishCheck(id: number, input: FinishVerificationCheckInput): void {
    const evidenceRef =
      input.evidenceRef === undefined || input.evidenceRef === null
        ? null
        : input.evidenceRef.trim();

    if (input.status === 'PASS') {
      if (input.commandRunId !== undefined && input.commandRunId !== null) {
        const run = this.db
          .prepare('SELECT status, exit_code AS exitCode FROM command_runs WHERE id = ?')
          .get(input.commandRunId) as
          | { status: string; exitCode: number | null }
          | undefined;
        if (run === undefined || run.status !== 'SUCCEEDED' || run.exitCode !== 0) {
          throw new Error('PASS requires successful command evidence');
        }
      } else if (evidenceRef === null || evidenceRef.length === 0) {
        throw new Error('PASS requires explicit verification evidence');
      }
    }

    const result = this.db
      .prepare(`
        UPDATE verification_checks
        SET status = ?,
            command_run_id = ?,
            evidence_ref = ?,
            reason = ?,
            started_at = COALESCE(started_at, ?),
            finished_at = ?
        WHERE id = ? AND status = 'PENDING'
      `)
      .run(
        input.status,
        input.commandRunId ?? null,
        evidenceRef,
        input.reason ?? null,
        input.startedAt ?? new Date().toISOString(),
        input.finishedAt ?? new Date().toISOString(),
        id,
      );
    if (result.changes !== 1) {
      throw new Error(`Verification check ${id} is not PENDING`);
    }
  }
}
