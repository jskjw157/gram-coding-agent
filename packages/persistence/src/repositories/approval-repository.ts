import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'CONSUMED' | 'DENIED' | 'EXPIRED';

export interface RequestApprovalInput {
  taskId: TaskId;
  operationHash: string;
  policyDecisionId?: number | null;
}

export interface StoredApproval {
  id: number;
  taskId: TaskId;
  policyDecisionId: number | null;
  operationHash: string;
  status: ApprovalStatus;
  requestedAt: string;
  approvedAt: string | null;
  consumedAt: string | null;
  expiresAt: string | null;
}

export class ApprovalNotFoundError extends Error {
  constructor(id: number) {
    super(`Approval ${id} was not found`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalHashMismatchError extends Error {
  constructor(id: number) {
    super(`Approval ${id} operation hash does not match`);
    this.name = 'ApprovalHashMismatchError';
  }
}

export class ApprovalAlreadyResolvedError extends Error {
  constructor(id: number, status: string) {
    super(`Approval ${id} is already resolved with status ${status}`);
    this.name = 'ApprovalAlreadyResolvedError';
  }
}

interface ApprovalRow {
  id: number;
  task_id: TaskId;
  policy_decision_id: number | null;
  operation_hash: string;
  status: string;
  requested_at: string;
  approved_at: string | null;
  consumed_at: string | null;
  expires_at: string | null;
}

const LIVE_STATUSES = new Set<string>(['PENDING', 'APPROVED']);

function decode(row: ApprovalRow): StoredApproval {
  if (!LIVE_STATUSES.has(row.status) && row.status !== 'CONSUMED' && row.status !== 'DENIED' && row.status !== 'EXPIRED') {
    throw new Error(`Approval row ${row.id} has invalid status ${row.status}`);
  }
  if (row.operation_hash.length === 0) {
    throw new Error(`Approval row ${row.id} is missing operation_hash`);
  }
  if (row.requested_at.length === 0) {
    throw new Error(`Approval row ${row.id} is missing requested_at`);
  }
  return {
    id: row.id,
    taskId: row.task_id,
    policyDecisionId: row.policy_decision_id,
    operationHash: row.operation_hash,
    status: row.status as ApprovalStatus,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export class ApprovalRepository {
  constructor(private readonly db: Database.Database) {}

  request(input: RequestApprovalInput): StoredApproval {
    if (input.operationHash.length === 0) {
      throw new Error('operationHash must not be empty');
    }
    const transaction = this.db.transaction((): StoredApproval => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE approvals
           SET status = 'EXPIRED'
           WHERE task_id = ? AND operation_hash = ? AND status = 'APPROVED' AND expires_at <= ?`,
        )
        .run(input.taskId, input.operationHash, now);

      const live = this.db
        .prepare(
          `SELECT * FROM approvals
           WHERE task_id = ? AND operation_hash = ? AND status IN ('PENDING', 'APPROVED')
           ORDER BY id DESC LIMIT 1`,
        )
        .get(input.taskId, input.operationHash) as ApprovalRow | undefined;
      if (live !== undefined) {
        return decode(live);
      }

      const result = this.db
        .prepare(
          `INSERT INTO approvals(task_id, policy_decision_id, operation_hash, status, requested_at)
           VALUES (?, ?, ?, 'PENDING', ?)`,
        )
        .run(input.taskId, input.policyDecisionId ?? null, input.operationHash, now);
      const id = Number(result.lastInsertRowid);
      const stored = this.get(id);
      if (stored === undefined) throw new Error('Approval row was not persisted');
      return stored;
    });

    try {
      return transaction.immediate();
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const live = this.db
        .prepare(
          `SELECT * FROM approvals
           WHERE task_id = ? AND operation_hash = ? AND status IN ('PENDING', 'APPROVED')
           ORDER BY id DESC LIMIT 1`,
        )
        .get(input.taskId, input.operationHash) as ApprovalRow | undefined;
      if (live !== undefined) return decode(live);
      throw error;
    }
  }

  get(id: number): StoredApproval | undefined {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    return row === undefined ? undefined : decode(row);
  }

  listForTask(taskId: TaskId): StoredApproval[] {
    const rows = this.db
      .prepare('SELECT * FROM approvals WHERE task_id = ? ORDER BY id')
      .all(taskId) as ApprovalRow[];
    return rows.map(decode);
  }

  approve(id: number, expectedOperationHash: string): StoredApproval {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    if (row === undefined) throw new ApprovalNotFoundError(id);
    if (row.operation_hash !== expectedOperationHash) throw new ApprovalHashMismatchError(id);
    if (row.status !== 'PENDING') throw new ApprovalAlreadyResolvedError(id, row.status);

    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE approvals
         SET status = 'APPROVED', approved_at = ?, expires_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .run(now, expiresAt, id);
    if (result.changes !== 1) {
      const current = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
        | ApprovalRow
        | undefined;
      throw new ApprovalAlreadyResolvedError(id, current?.status ?? 'UNKNOWN');
    }
    const stored = this.get(id);
    if (stored === undefined) throw new Error(`Approval ${id} was not persisted`);
    return stored;
  }

  deny(id: number, expectedOperationHash: string): StoredApproval {
    const row = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
      | ApprovalRow
      | undefined;
    if (row === undefined) throw new ApprovalNotFoundError(id);
    if (row.operation_hash !== expectedOperationHash) throw new ApprovalHashMismatchError(id);
    if (row.status !== 'PENDING') throw new ApprovalAlreadyResolvedError(id, row.status);

    const result = this.db
      .prepare(`UPDATE approvals SET status = 'DENIED' WHERE id = ? AND status = 'PENDING'`)
      .run(id);
    if (result.changes !== 1) {
      const current = this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as
        | ApprovalRow
        | undefined;
      throw new ApprovalAlreadyResolvedError(id, current?.status ?? 'UNKNOWN');
    }
    const stored = this.get(id);
    if (stored === undefined) throw new Error(`Approval ${id} was not persisted`);
    return stored;
  }

  consume(taskId: TaskId, operationHash: string): boolean {
    const transaction = this.db.transaction((): boolean => {
      const now = new Date().toISOString();
      this.db
        .prepare(
          `UPDATE approvals
           SET status = 'EXPIRED'
           WHERE task_id = ? AND operation_hash = ? AND status = 'APPROVED' AND expires_at <= ?`,
        )
        .run(taskId, operationHash, now);

      const result = this.db
        .prepare(
          `UPDATE approvals
           SET status = 'CONSUMED', consumed_at = ?
           WHERE task_id = ? AND operation_hash = ? AND status = 'APPROVED' AND expires_at > ?`,
        )
        .run(now, taskId, operationHash, now);
      return result.changes === 1;
    });

    return transaction.immediate();
  }
}
