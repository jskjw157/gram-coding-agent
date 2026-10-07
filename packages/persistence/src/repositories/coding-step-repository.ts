import type Database from 'better-sqlite3';
import type { TaskId } from '@gram/domain';

export type CodingStepPhase = 'INSTRUCTIONS' | 'ANALYZE' | 'MODIFY';
export type CodingStepTerminalState = 'SUCCEEDED' | 'FAILED' | 'INTERRUPTED';
export type CodingStepState = 'PENDING' | 'APPLYING' | CodingStepTerminalState;

export interface CreateCodingStepInput {
  id: string;
  taskId: TaskId;
  workspaceId: number;
  workspacePath: string;
  branch: string;
  phase: CodingStepPhase;
  runId: string;
  expiresAt: string;
}

export interface StoredCodingStep extends CreateCodingStepInput {
  state: CodingStepState;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export class CodingStepRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateCodingStepInput): StoredCodingStep {
    const expiresAt = new Date(input.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== input.expiresAt) {
      throw new Error('expiresAt must be a canonical ISO timestamp');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      INSERT INTO coding_steps (
        id, task_id, workspace_id, workspace_path, branch, phase, run_id,
        state, created_at, updated_at, expires_at, finished_at
      )
      SELECT ?, task_id, id, linux_path, branch, ?, ?, 'PENDING', ?, ?, ?, NULL
      FROM workspaces
      WHERE id = ? AND task_id = ? AND linux_path = ? AND branch = ?
    `).run(
      input.id, input.phase, input.runId, now, now, input.expiresAt,
      input.workspaceId, input.taskId, input.workspacePath, input.branch,
    );
    if (result.changes !== 1) throw new Error('Coding step workspace binding does not match');

    const stored = this.get(input.id);
    if (stored === undefined) throw new Error('Coding step row was not persisted');
    return stored;
  }

  get(id: string): StoredCodingStep | undefined {
    return this.db.prepare(`
      SELECT id, task_id AS taskId, workspace_id AS workspaceId,
             workspace_path AS workspacePath, branch, phase, run_id AS runId,
             state, created_at AS createdAt, updated_at AS updatedAt,
             expires_at AS expiresAt, finished_at AS finishedAt
      FROM coding_steps WHERE id = ?
    `).get(id) as StoredCodingStep | undefined;
  }

  claim(id: string, taskId: TaskId, runId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE coding_steps SET state = 'APPLYING', updated_at = ?
      WHERE id = ? AND task_id = ? AND run_id = ? AND state = 'PENDING' AND expires_at > ?
    `).run(now, id, taskId, runId, now);
    return result.changes === 1;
  }

  finish(id: string, runId: string, state: CodingStepTerminalState): void {
    if (state !== 'SUCCEEDED' && state !== 'FAILED' && state !== 'INTERRUPTED') {
      throw new Error('Invalid coding step terminal transition');
    }
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE coding_steps SET state = ?, updated_at = ?, finished_at = ?
      WHERE id = ? AND run_id = ?
        AND (state = 'APPLYING' OR (state = 'PENDING' AND ? <> 'SUCCEEDED'))
    `).run(state, now, now, id, runId, state);
    if (result.changes !== 1) throw new Error('Coding step terminal transition was rejected');
  }

  interruptPending(): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE coding_steps SET state = 'INTERRUPTED', updated_at = ?, finished_at = ?
      WHERE state IN ('PENDING', 'APPLYING')
    `).run(now, now);
  }
}
