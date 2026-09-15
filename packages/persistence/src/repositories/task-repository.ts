import type Database from 'better-sqlite3';
import { createTaskId, type PublishMode, type TaskId, type TaskStatus } from '@gram/domain';

export interface CreateStoredTaskInput {
  goal: string;
  taskType: string;
  publishMode: PublishMode;
  repoId?: number | null;
  repoSelector?: string | null;
  priority?: number;
  metadata?: unknown;
}

export interface StoredTask {
  id: TaskId;
  seq: number;
  goal: string;
  repoId: number | null;
  repoSelector: string | null;
  status: TaskStatus;
  taskType: string;
  publishMode: PublishMode;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export class ConcurrentTaskTransitionError extends Error {
  constructor(taskId: TaskId, expectedFrom: TaskStatus, to: TaskStatus) {
    super(`Task ${taskId} was not in expected state ${expectedFrom} while transitioning to ${to}`);
    this.name = 'ConcurrentTaskTransitionError';
  }
}

export class TaskRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: CreateStoredTaskInput): StoredTask {
    const createTransaction = this.db.transaction((value: CreateStoredTaskInput) => {
      const sequence = this.db
        .prepare('SELECT next_value FROM task_sequence WHERE singleton = 1')
        .get() as { next_value: number } | undefined;
      if (!sequence) throw new Error('task sequence is not initialized');

      this.db
        .prepare('UPDATE task_sequence SET next_value = ? WHERE singleton = 1')
        .run(sequence.next_value + 1);

      const id = createTaskId();
      const now = new Date().toISOString();
      this.db
        .prepare(`
          INSERT INTO tasks (
            id, seq, goal, repo_id, repo_selector, status, task_type, publish_mode,
            priority, metadata_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          sequence.next_value,
          value.goal,
          value.repoId ?? null,
          value.repoSelector ?? null,
          value.taskType,
          value.publishMode,
          value.priority ?? 2,
          value.metadata === undefined ? null : JSON.stringify(value.metadata),
          now,
          now,
        );

      const stored = this.get(id);
      if (!stored) throw new Error(`failed to read newly created task ${id}`);
      return stored;
    });

    return createTransaction.immediate(input);
  }

  get(id: TaskId): StoredTask | null {
    const row = this.db
      .prepare(`
        SELECT
          id,
          seq,
          goal,
          repo_id AS repoId,
          repo_selector AS repoSelector,
          status,
          task_type AS taskType,
          publish_mode AS publishMode,
          priority,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM tasks
        WHERE id = ?
      `)
      .get(id) as StoredTask | undefined;
    return row ?? null;
  }

  transition(id: TaskId, expectedFrom: TaskStatus, to: TaskStatus): void {
    const result = this.db
      .prepare(`
        UPDATE tasks
        SET status = ?, updated_at = ?
        WHERE id = ? AND status = ?
      `)
      .run(to, new Date().toISOString(), id, expectedFrom);

    if (result.changes !== 1) {
      throw new ConcurrentTaskTransitionError(id, expectedFrom, to);
    }
  }
}
