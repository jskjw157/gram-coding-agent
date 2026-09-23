import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export interface PullRequestVerificationEvidence {
  name: string;
  required: boolean;
  status: string;
  hasEvidence: boolean;
}

export interface StoredPullRequestEvidence {
  taskId: TaskId;
  summary: string;
  rootCause?: string;
  changedPaths: string[];
  verification: PullRequestVerificationEvidence[];
}

interface TaskEvidenceRow {
  goal: string;
  result_summary: string | null;
  metadata_json: string | null;
}

interface VerificationEvidenceRow {
  name: string;
  required: number;
  status: string;
  command_run_id: number | null;
  evidence_ref: string | null;
}

function parseMetadata(value: string | null): Record<string, unknown> {
  if (value === null) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )];
}

function pathsFromDiffReview(rows: readonly VerificationEvidenceRow[]): string[] {
  const diffReview = rows.find((row) => row.name === 'diff-review');
  const ref = diffReview?.evidence_ref;
  if (ref === null || ref === undefined || !ref.startsWith('diff-review:')) {
    return [];
  }
  return [...new Set(
    ref
      .slice('diff-review:'.length)
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path.length > 0 && path !== 'clean'),
  )];
}

export class PullRequestEvidenceRepository {
  constructor(private readonly db: Database.Database) {}

  readForTask(taskId: TaskId): StoredPullRequestEvidence {
    const task = this.db
      .prepare(
        'SELECT goal, result_summary, metadata_json FROM tasks WHERE id = ?',
      )
      .get(taskId) as TaskEvidenceRow | undefined;
    if (task === undefined) throw new Error(`Task not found: ${taskId}`);

    const metadata = parseMetadata(task.metadata_json);
    const rows = this.db
      .prepare(`
        SELECT
          name,
          required,
          status,
          command_run_id,
          evidence_ref
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
      .all(taskId, taskId) as VerificationEvidenceRow[];

    const metadataPaths = stringArray(metadata.changedPaths);
    const changedPaths =
      metadataPaths.length > 0 ? metadataPaths : pathsFromDiffReview(rows);

    const summary =
      nonEmptyString(task.result_summary) ??
      nonEmptyString(metadata.summary) ??
      task.goal;

    const rootCause = nonEmptyString(metadata.rootCause);

    return {
      taskId,
      summary,
      ...(rootCause === undefined ? {} : { rootCause }),
      changedPaths,
      verification: rows.map((row) => ({
        name: row.name,
        required: row.required === 1,
        status: row.status,
        hasEvidence:
          row.command_run_id !== null ||
          (row.evidence_ref !== null && row.evidence_ref.trim().length > 0),
      })),
    };
  }
}
