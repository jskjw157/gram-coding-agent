import { isAbsolute, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export type StoredVerificationCheckStatus = 'PENDING' | 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_REQUIRED';

export interface VerificationSnapshot {
  version: 1;
  taskId: string;
  headSha: string;
  entries: {
    path: string;
    mode: '000000' | '100644' | '100755';
    oid: string | null;
  }[];
}

export interface BoundVerificationPlan {
  id: number;
  taskId: string;
  headSha: string;
  snapshot: VerificationSnapshot;
  approvedPaths: string[];
  checks: StoredVerificationCheck[];
}

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
  approvedPaths?: readonly string[];
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

interface VerificationPlanRow {
  id: number;
  task_id: TaskId;
  head_sha: string | null;
  plan_json: string;
}

interface ReviewEvidence {
  checkId: number;
  evidenceRef: string;
  approvedPaths: string[];
}

interface VerificationEvidence {
  version: 1;
  commandFloor?: number;
  reviews: ReviewEvidence[];
  snapshot?: VerificationSnapshot;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/^[-/]/.test(value) &&
    !/[\\:*?[\]]/.test(value) &&
    ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}

function validPaths(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((path, index) => validPath(path) && (index === 0 || value[index - 1] < path))
  );
}

function validSnapshot(value: unknown): value is VerificationSnapshot {
  if (
    !object(value) ||
    value.version !== 1 ||
    typeof value.taskId !== 'string' ||
    typeof value.headSha !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.headSha) ||
    !Array.isArray(value.entries)
  )
    return false;
  let previous: string | undefined;
  for (const entry of value.entries) {
    if (!object(entry) || !validPath(entry.path) || (previous !== undefined && previous >= entry.path)) return false;
    if (entry.mode === '000000') {
      if (entry.oid !== null) return false;
    } else if (
      (entry.mode !== '100644' && entry.mode !== '100755') ||
      typeof entry.oid !== 'string' ||
      !/^[a-f0-9]{40}$/.test(entry.oid)
    )
      return false;
    previous = entry.path;
  }
  return true;
}

function readPlanJson(row: VerificationPlanRow): Record<string, unknown> {
  const plan: unknown = JSON.parse(row.plan_json);
  if (!object(plan)) throw new Error('Verification plan evidence requires an object');
  return plan;
}

function readEvidence(plan: Record<string, unknown>): VerificationEvidence {
  if (!Object.hasOwn(plan, 'verificationEvidence')) return { version: 1, reviews: [] };
  const evidence = plan.verificationEvidence;
  if (!object(evidence) || evidence.version !== 1 || !Array.isArray(evidence.reviews)) {
    throw new Error('Invalid verification evidence');
  }
  if (evidence.commandFloor !== undefined &&
      (typeof evidence.commandFloor !== 'number' || !Number.isSafeInteger(evidence.commandFloor) || evidence.commandFloor < 0)) {
    throw new Error('Invalid verification command watermark');
  }
  const ids = new Set<number>();
  for (const review of evidence.reviews) {
    if (
      !object(review) ||
      typeof review.checkId !== 'number' ||
      !Number.isSafeInteger(review.checkId) ||
      review.checkId <= 0 ||
      ids.has(review.checkId) ||
      typeof review.evidenceRef !== 'string' ||
      review.evidenceRef.trim().length === 0 ||
      !validPaths(review.approvedPaths)
    )
      throw new Error('Invalid diff-review evidence');
    ids.add(review.checkId);
  }
  if (Object.hasOwn(evidence, 'snapshot') && !validSnapshot(evidence.snapshot)) {
    throw new Error('Invalid verification snapshot');
  }
  return evidence as unknown as VerificationEvidence;
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
    hasEvidence: row.command_run_id !== null || (row.evidence_ref !== null && row.evidence_ref.trim().length > 0),
  };
}

export class VerificationRepository {
  constructor(private readonly db: Database.Database) {}

  createPlan(input: CreateVerificationPlanInput): number {
    return this.db.transaction(() => {
      if (object(input.plan) && Object.hasOwn(input.plan, 'verificationEvidence')) {
        throw new Error('verificationEvidence is reserved repository metadata');
      }
      const json = JSON.stringify(input.plan);
      if (json === undefined) throw new Error('Verification plan must be JSON serializable');
      const serialized: unknown = JSON.parse(json);
      if (object(serialized) && Object.hasOwn(serialized, 'verificationEvidence')) {
        throw new Error('verificationEvidence is reserved repository metadata');
      }
      const watermark = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM command_runs').get() as { id: number };
      const storedJson = object(serialized)
        ? JSON.stringify({ ...serialized, verificationEvidence: { version: 1, reviews: [], commandFloor: watermark.id } })
        : json;
      const result = this.db
        .prepare(
          `
          INSERT INTO verification_plans(
            task_id, head_sha, change_class, risk, plan_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
        )
        .run(
          input.taskId,
          input.headSha ?? null,
          input.changeClass,
          input.risk ?? null,
          storedJson,
          input.createdAt ?? new Date().toISOString(),
        );
      return Number(result.lastInsertRowid);
      }).immediate();
  }

  createCheck(input: CreateVerificationCheckInput): number {
    return this.db
      .transaction(() => {
        const plan = this.getPlan(input.planId);
        if (plan === undefined || plan.task_id !== input.taskId) {
          throw new Error('Verification check task does not match plan task');
        }
        if (readEvidence(readPlanJson(plan)).snapshot !== undefined) throw new Error('Verification plan is sealed');
        const result = this.db
          .prepare(
            `
          INSERT INTO verification_checks(
            plan_id, task_id, name, required, status, reason
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
          )
          .run(
            input.planId,
            input.taskId,
            input.name,
            input.required ? 1 : 0,
            input.status ?? 'PENDING',
            input.reason ?? null,
          );
        return Number(result.lastInsertRowid);
      })
      .immediate();
  }

  getCheck(id: number): StoredVerificationCheck | undefined {
    const row = this.db.prepare('SELECT * FROM verification_checks WHERE id = ?').get(id) as
      VerificationCheckRow | undefined;
    return row === undefined ? undefined : decodeCheck(row);
  }

  listForTask(taskId: TaskId, headSha?: string): StoredVerificationCheck[] {
    const plan = this.latestPlan(taskId, headSha);
    return plan === undefined ? [] : this.listForPlan(plan.id).filter((check) => check.taskId === taskId);
  }

  getBoundPlan(taskId: TaskId, headSha: string, planId?: number): BoundVerificationPlan | undefined {
    return this.db.transaction(() => {
      const row = this.latestPlan(taskId, headSha);
      if (row === undefined || (planId !== undefined && row.id !== planId)) return undefined;
      try {
        const evidence = readEvidence(readPlanJson(row));
        if (evidence.snapshot === undefined) return undefined;
        return this.boundPlan(row, evidence.snapshot, evidence);
      } catch {
        // Malformed, incomplete or foreign persisted proof must never authorize publication.
        return undefined;
      }
    })();
  }

  sealSnapshot(planId: number, snapshot: VerificationSnapshot): void {
    this.db
      .transaction(() => {
        const row = this.getPlan(planId);
        if (row === undefined) throw new Error('Verification plan not found');
        const plan = readPlanJson(row);
        const evidence = readEvidence(plan);
        if (evidence.snapshot !== undefined) throw new Error('Verification snapshot is already sealed');
        this.boundPlan(row, snapshot, evidence);
        this.saveEvidence(planId, plan, { ...evidence, snapshot });
      })
      .immediate();
  }

  finishCheck(id: number, input: FinishVerificationCheckInput): void {
    this.db
      .transaction(() => {
        const check = this.getCheck(id);
        if (check === undefined || check.status !== 'PENDING')
          throw new Error(`Verification check ${id} is not PENDING`);
        const row = this.getPlan(check.planId);
        if (row === undefined || row.task_id !== check.taskId)
          throw new Error('Verification check task does not match plan task');
        const plan = readPlanJson(row);
        const evidence = readEvidence(plan);
        if (evidence.snapshot !== undefined) throw new Error('Verification plan is sealed');
        const evidenceRef = input.evidenceRef?.trim() ?? null;
        if (input.status === 'PASS') {
          if (input.commandRunId !== undefined && input.commandRunId !== null) {
            this.assertCommandEvidence(input.commandRunId, check.taskId, check.id, evidence.commandFloor);
          } else if (evidenceRef === null || evidenceRef.length === 0) {
            throw new Error('PASS requires explicit verification evidence');
          }
        }
        if (input.approvedPaths !== undefined) {
          if (
            check.name !== 'diff-review' ||
            input.status !== 'PASS' ||
            input.commandRunId != null ||
            evidenceRef === null ||
            evidenceRef.length === 0
          ) {
            throw new Error('Approved paths require a passed non-command diff-review');
          }
          if (!Array.isArray(input.approvedPaths) || !input.approvedPaths.every(validPath)) {
            throw new Error('Invalid diff-review path');
          }
          evidence.reviews.push({ checkId: id, evidenceRef, approvedPaths: [...new Set(input.approvedPaths)].sort() });
        }
        const result = this.db
          .prepare(
            `
        UPDATE verification_checks
        SET status = ?, command_run_id = ?, evidence_ref = ?, reason = ?,
            started_at = COALESCE(started_at, ?), finished_at = ?
        WHERE id = ? AND status = 'PENDING'
      `,
          )
          .run(
            input.status,
            input.commandRunId ?? null,
            evidenceRef,
            input.reason ?? null,
            input.startedAt ?? new Date().toISOString(),
            input.finishedAt ?? new Date().toISOString(),
            id,
          );
        if (result.changes !== 1) throw new Error(`Verification check ${id} is not PENDING`);
        if (input.approvedPaths !== undefined) this.saveEvidence(row.id, plan, evidence);
      })
      .immediate();
  }

  private getPlan(id: number): VerificationPlanRow | undefined {
    return this.db.prepare('SELECT id, task_id, head_sha, plan_json FROM verification_plans WHERE id = ?').get(id) as
      VerificationPlanRow | undefined;
  }

  private latestPlan(taskId: TaskId, headSha?: string): VerificationPlanRow | undefined {
    return this.db
      .prepare(
        `
      SELECT id, task_id, head_sha, plan_json FROM verification_plans
      WHERE task_id = ? ${headSha === undefined ? '' : 'AND head_sha = ?'}
      ORDER BY id DESC LIMIT 1
    `,
      )
      .get(...(headSha === undefined ? [taskId] : [taskId, headSha])) as VerificationPlanRow | undefined;
  }

  private listForPlan(planId: number): StoredVerificationCheck[] {
    const rows = this.db
      .prepare('SELECT * FROM verification_checks WHERE plan_id = ? ORDER BY id')
      .all(planId) as VerificationCheckRow[];
    return rows.map(decodeCheck);
  }

  private assertCommandEvidence(commandRunId: number, taskId: TaskId, checkId: number, floor?: number, requireWorkspace = false): void {
    const run = this.db
      .prepare('SELECT task_id, cwd, category, status, exit_code FROM command_runs WHERE id = ?')
      .get(commandRunId) as { task_id: TaskId; cwd: string; category: string; status: string; exit_code: number | null } | undefined;
    if (run !== undefined && run.task_id !== taskId)
      throw new Error('Command evidence task does not match verification task');
    if (run === undefined || run.category !== 'VERIFICATION' || run.status !== 'SUCCEEDED' || run.exit_code !== 0) {
      throw new Error('PASS requires successful command evidence');
    }
    if ((requireWorkspace && floor === undefined) || (floor !== undefined && commandRunId <= floor)) {
      throw new Error('Command evidence predates this verification plan');
    }
    const consumed = this.db.prepare('SELECT id FROM verification_checks WHERE command_run_id = ? AND id != ? LIMIT 1')
      .get(commandRunId, checkId);
    if (consumed !== undefined) throw new Error('Command evidence is already consumed by another check');
    if (requireWorkspace) {
      const workspace = this.db.prepare('SELECT linux_path FROM workspaces WHERE task_id = ?').get(taskId) as { linux_path: string } | undefined;
      if (workspace === undefined || !isAbsolute(run.cwd) || !isAbsolute(workspace.linux_path) || resolve(run.cwd) !== resolve(workspace.linux_path)) {
        throw new Error('Command evidence cwd is not the registered task workspace');
      }
    }
  }

  private boundPlan(
    row: VerificationPlanRow,
    snapshot: VerificationSnapshot,
    evidence: VerificationEvidence,
  ): BoundVerificationPlan {
    if (!validSnapshot(snapshot) || snapshot.taskId !== row.task_id || snapshot.headSha !== row.head_sha) {
      throw new Error('Verification snapshot does not match plan task and HEAD');
    }
    const checks = this.listForPlan(row.id);
    if (checks.some((check) => check.taskId !== row.task_id)) throw new Error('Foreign task check evidence');
    const required = checks.filter((check) => check.required);
    if (required.length === 0) throw new Error('Verification requires required checks');
    for (const check of required) {
      if (check.status !== 'PASS' || !check.hasEvidence) throw new Error('Required checks lack passed evidence');
      if (check.commandRunId !== null) this.assertCommandEvidence(check.commandRunId, row.task_id, check.id, evidence.commandFloor, true);
    }
    for (const review of evidence.reviews) {
      const check = checks.find((candidate) => candidate.id === review.checkId);
      if (
        check?.name !== 'diff-review' ||
        check.status !== 'PASS' ||
        check.commandRunId !== null ||
        check.evidenceRef !== review.evidenceRef
      )
        throw new Error('Diff-review evidence does not match its check');
    }
    const reviews = required.filter((check) => check.name === 'diff-review');
    if (reviews.length === 0) throw new Error('Required diff-review evidence is missing');
    const approvedPaths = new Set<string>();
    for (const review of reviews) {
      const recorded = evidence.reviews.find((candidate) => candidate.checkId === review.id);
      if (recorded === undefined) throw new Error('Required diff-review paths are missing');
      for (const path of recorded.approvedPaths) approvedPaths.add(path);
    }
    const candidates = new Set(snapshot.entries.map((entry) => entry.path));
    if ([...approvedPaths].some((path) => !candidates.has(path)))
      throw new Error('Reviewed path is absent from verification snapshot');
    return {
      id: row.id,
      taskId: row.task_id,
      headSha: snapshot.headSha,
      snapshot,
      approvedPaths: [...approvedPaths].sort(),
      checks,
    };
  }

  private saveEvidence(planId: number, plan: Record<string, unknown>, evidence: VerificationEvidence): void {
    this.db
      .prepare('UPDATE verification_plans SET plan_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...plan, verificationEvidence: evidence }), planId);
  }
}
