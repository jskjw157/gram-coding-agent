import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';
import { VerificationRepository } from './verification-repository.js';

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

function publishablePath(path: string): boolean {
  // Legacy metadata also crosses this public-output boundary. Keep canonical
  // repository paths, and reject Markdown injection and recognizable credentials.
  return path.length > 0 && !/^[-/]/.test(path) && !/[\\:*?[\]`<>]/.test(path) &&
    ![...path].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git') &&
    !/(?:sk-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{10,}|gh[opusr]_[A-Za-z0-9]{10,})/.test(path);
}

export class PullRequestEvidenceRepository {
  constructor(private readonly db: Database.Database) {}

  readForTask(taskId: TaskId): StoredPullRequestEvidence {
    return this.db.transaction(() => this.readSnapshot(taskId))();
  }

  private readSnapshot(taskId: TaskId): StoredPullRequestEvidence {
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

    const plan = this.db.prepare(`
      SELECT id, head_sha, plan_json FROM verification_plans
      WHERE task_id = ? ORDER BY id DESC LIMIT 1
    `).get(taskId) as { id: number; head_sha: string | null; plan_json: string } | undefined;
    const externalReviews = parseMetadata(plan?.plan_json ?? null).externalReviews === true;
    const external = externalReviews ||
      rows.some(row => row.evidence_ref?.startsWith('external-review:')) ||
      (plan !== undefined && this.db.prepare(
        'SELECT 1 FROM verification_reviews WHERE plan_id = ? LIMIT 1',
      ).get(plan.id) !== undefined);
    const metadataPaths = stringArray(metadata.changedPaths);
    let changedPaths: string[];
    if (external) {
      // Review HEAD is the sealed pre-commit baseline, not the later published SHA.
      // Reuse the publication gate's exact task/plan/check/review/snapshot bindings.
      const bound = !externalReviews || plan?.head_sha === null || plan === undefined ? undefined :
        new VerificationRepository(this.db).getBoundPlan(taskId, plan.head_sha, plan.id);
      changedPaths = bound?.approvedPaths ?? [];
    } else {
      changedPaths = metadataPaths.length > 0 ? metadataPaths : pathsFromDiffReview(rows);
    }
    if (!changedPaths.every(publishablePath)) changedPaths = [];

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
