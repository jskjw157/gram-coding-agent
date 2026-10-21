import type Database from 'better-sqlite3';
export type VerificationReviewName = 'secret-scan' | 'diff-review';
export interface CreateVerificationReview {
  id: string;
  taskId: string;
  workspaceId: number;
  workspacePath: string;
  branch: string;
  planId: number;
  checkId: number;
  checkName: VerificationReviewName;
  headSha: string;
  snapshotDigest: string;
  runId: string;
  expiresAt: string;
}
export interface ReviewAcknowledgement {
  path: string;
  digest: string;
}
export interface ReviewDecision {
  decision: 'PASS' | 'FAIL';
  views: ReviewAcknowledgement[];
  approvedPaths: string[];
}
export interface StoredVerificationReview extends CreateVerificationReview, Omit<ReviewDecision, 'decision'> {
  decision: 'PASS' | 'FAIL' | null;
  state: 'PENDING' | 'ACCEPTED' | 'FAILED' | 'INTERRUPTED';
  createdAt: string;
  finishedAt: string | null;
  evidenceRef: string;
}
const SELECT = `SELECT id, task_id AS taskId, workspace_id AS workspaceId, workspace_path AS workspacePath,
  branch, plan_id AS planId, check_id AS checkId, check_name AS checkName, head_sha AS headSha,
  snapshot_digest AS snapshotDigest, run_id AS runId, expires_at AS expiresAt, created_at AS createdAt,
  finished_at AS finishedAt, state, decision, views_json AS viewsJson, approved_paths_json AS pathsJson
  FROM verification_reviews`;
export class VerificationReviewRepository {
  constructor(private readonly db: Database.Database) {}
  create(input: CreateVerificationReview): StoredVerificationReview {
    if (
      !/^[a-f0-9]{40}$/.test(input.headSha) ||
      !/^[a-f0-9]{64}$/.test(input.snapshotDigest) ||
      !Number.isFinite(Date.parse(input.expiresAt)) ||
      new Date(input.expiresAt).toISOString() !== input.expiresAt
    )
      throw new Error('Invalid review identity');
    const result = this.db
      .prepare(
        `INSERT INTO verification_reviews
      (id,task_id,workspace_id,workspace_path,branch,plan_id,check_id,check_name,head_sha,snapshot_digest,run_id,state,created_at,expires_at)
      SELECT ?, t.id, w.id, w.linux_path, w.branch, p.id, c.id, c.name, p.head_sha, ?, ?, 'PENDING', ?, ?
      FROM tasks t JOIN workspaces w ON w.task_id=t.id AND w.repo_id=t.repo_id
      JOIN verification_plans p ON p.task_id=t.id JOIN verification_checks c ON c.plan_id=p.id AND c.task_id=t.id
      WHERE t.id=? AND t.status='VERIFYING' AND w.id=? AND w.linux_path=? AND w.branch=?
        AND p.id=? AND p.head_sha=? AND c.id=? AND c.name=? AND c.status='PENDING'`,
      )
      .run(
        input.id,
        input.snapshotDigest,
        input.runId,
        new Date().toISOString(),
        input.expiresAt,
        input.taskId,
        input.workspaceId,
        input.workspacePath,
        input.branch,
        input.planId,
        input.headSha,
        input.checkId,
        input.checkName,
      );
    if (result.changes !== 1) throw new Error('Verification review binding does not match');
    const stored = this.get(input.id);
    if (stored === undefined) throw new Error('Verification review was not persisted');
    return stored;
  }
  get(id: string): StoredVerificationReview | undefined {
    const row = this.db.prepare(`${SELECT} WHERE id=?`).get(id) as
      | (Omit<StoredVerificationReview, 'views' | 'approvedPaths' | 'evidenceRef'> & {
          viewsJson: string;
          pathsJson: string;
        })
      | undefined;
    if (row === undefined) return undefined;
    const { viewsJson, pathsJson, ...record } = row;
    return {
      ...record,
      views: JSON.parse(viewsJson) as ReviewAcknowledgement[],
      approvedPaths: JSON.parse(pathsJson) as string[],
      evidenceRef: `external-review:${id}`,
    };
  }
  accept(id: string, runId: string, decision: ReviewDecision): StoredVerificationReview {
    if (
      !['PASS', 'FAIL'].includes(decision.decision) ||
      decision.views.length > 100 ||
      decision.approvedPaths.length > 100 ||
      decision.views.some((v) => typeof v.path !== 'string' || !/^[a-f0-9]{64}$/.test(v.digest)) ||
      decision.approvedPaths.some((p) => typeof p !== 'string') ||
      new Set(decision.views.map((v) => v.path)).size !== decision.views.length ||
      new Set(decision.approvedPaths).size !== decision.approvedPaths.length
    )
      throw new Error('Invalid review decision');
    const now = new Date().toISOString();
    const changed = this.db
      .prepare(
        `UPDATE verification_reviews SET state='ACCEPTED', decision=?, views_json=?, approved_paths_json=?, finished_at=?
      WHERE id=? AND run_id=? AND state='PENDING' AND expires_at>?`,
      )
      .run(
        decision.decision,
        JSON.stringify(decision.views),
        JSON.stringify(decision.approvedPaths),
        now,
        id,
        runId,
        now,
      );
    if (changed.changes !== 1) throw new Error('Verification review acceptance was rejected');
    const stored = this.get(id);
    if (stored === undefined) throw new Error('Verification review was not persisted');
    return stored;
  }
  stop(id: string, runId: string, state: 'FAILED' | 'INTERRUPTED'): void {
    this.db
      .prepare("UPDATE verification_reviews SET state=?, finished_at=? WHERE id=? AND run_id=? AND state='PENDING'")
      .run(state, new Date().toISOString(), id, runId);
  }
  interruptPending(): void {
    this.db
      .prepare("UPDATE verification_reviews SET state='INTERRUPTED', finished_at=? WHERE state='PENDING'")
      .run(new Date().toISOString());
  }
}
