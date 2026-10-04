import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export const REQUEST_CONFLICT = 'REQUEST_CONFLICT' as const;

export class RequestConflictError extends Error {
  readonly code: typeof REQUEST_CONFLICT = REQUEST_CONFLICT;
  constructor(message: string) {
    super(message);
    this.name = 'RequestConflictError';
  }
}

export interface CreateOperationInput {
  taskId: TaskId;
  step: string;
  revision: number;
  requesterId: string;
  clientRequestId: string;
  status?: string;
  metadata?: unknown;
  digest?: string;
  receipt?: unknown;
}

export interface StoredOperation {
  id: number;
  taskId: TaskId;
  step: string;
  revision: number;
  requesterId: string;
  clientRequestId: string;
  status: string;
  metadataJson: string | null;
  digest: string | null;
  receiptJson: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OperationRow {
  id: number;
  task_id: TaskId;
  step: string;
  revision: number;
  requester_id: string;
  client_request_id: string;
  status: string;
  metadata_json: string | null;
  digest: string | null;
  receipt_json: string | null;
  created_at: string;
  updated_at: string;
}

function toStored(row: OperationRow): StoredOperation {
  return {
    id: row.id,
    taskId: row.task_id,
    step: row.step,
    revision: row.revision,
    requesterId: row.requester_id,
    clientRequestId: row.client_request_id,
    status: row.status,
    metadataJson: row.metadata_json,
    digest: row.digest,
    receiptJson: row.receipt_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record['code'] === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  const message = record['message'];
  return typeof message === 'string' && message.includes('UNIQUE constraint failed');
}

export class OperationRepository {
  constructor(private readonly db: Database.Database) {}

  createOperation(input: CreateOperationInput): StoredOperation {
    const now = new Date().toISOString();
    const status = input.status ?? 'PENDING';
    const metadataJson = input.metadata === undefined ? null : JSON.stringify(input.metadata);
    const receiptJson = input.receipt === undefined ? null : JSON.stringify(input.receipt);
    const digest = input.digest ?? null;

    const createTransaction = this.db.transaction((): StoredOperation => {
      // Durable-before-effect ordering: touch the parent task row first so the
      // operation insert and audit write commit atomically with the touch.
      // When the task is missing the follow-up INSERT raises FOREIGN KEY,
      // leaving the (no-op) touch with no visible effect.
      this.db
        .prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
        .run(now, input.taskId);

      let operationId: number;
      try {
        const result = this.db
          .prepare(
            `INSERT INTO operations(
              task_id, step, revision, requester_id, client_request_id,
              status, metadata_json, digest, receipt_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.taskId,
            input.step,
            input.revision,
            input.requesterId,
            input.clientRequestId,
            status,
            metadataJson,
            digest,
            receiptJson,
            now,
            now,
          );
        operationId = Number(result.lastInsertRowid);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new RequestConflictError(
            `operation conflicts: task=${input.taskId} step=${input.step} revision=${input.revision} requester=${input.requesterId} clientRequest=${input.clientRequestId}`,
          );
        }
        throw error;
      }

      // D11 audit minimal evidence: canonical metadata/digest/sanitized receipt
      // only. Raw bodies are never accepted by the input type and never written.
      const canonical = JSON.stringify({
        operationId,
        taskId: input.taskId,
        step: input.step,
        revision: input.revision,
        requesterId: input.requesterId,
        metadata: input.metadata ?? null,
        digest,
        receipt: input.receipt ?? null,
      });
      this.db
        .prepare('INSERT INTO audit_events(task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)')
        .run(input.taskId, 'operation.created', canonical, now);

      const row = this.db
        .prepare(
          `SELECT id, task_id, step, revision, requester_id, client_request_id,
                  status, metadata_json, digest, receipt_json, created_at, updated_at
           FROM operations WHERE id = ?`,
        )
        .get(operationId) as OperationRow | undefined;
      if (!row) throw new Error(`failed to read newly created operation ${operationId}`);
      return toStored(row);
    });

    return createTransaction.immediate();
  }

  getById(id: number): StoredOperation | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id, step, revision, requester_id, client_request_id,
                status, metadata_json, digest, receipt_json, created_at, updated_at
         FROM operations WHERE id = ?`,
      )
      .get(id) as OperationRow | undefined;
    return row === undefined ? null : toStored(row);
  }

  getByRequest(requesterId: string, clientRequestId: string): StoredOperation | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id, step, revision, requester_id, client_request_id,
                status, metadata_json, digest, receipt_json, created_at, updated_at
         FROM operations WHERE requester_id = ? AND client_request_id = ?`,
      )
      .get(requesterId, clientRequestId) as OperationRow | undefined;
    return row === undefined ? null : toStored(row);
  }

  getByTaskStepRevision(taskId: TaskId, step: string, revision: number): StoredOperation | null {
    const row = this.db
      .prepare(
        `SELECT id, task_id, step, revision, requester_id, client_request_id,
                status, metadata_json, digest, receipt_json, created_at, updated_at
         FROM operations WHERE task_id = ? AND step = ? AND revision = ?`,
      )
      .get(taskId, step, revision) as OperationRow | undefined;
    return row === undefined ? null : toStored(row);
  }
}
