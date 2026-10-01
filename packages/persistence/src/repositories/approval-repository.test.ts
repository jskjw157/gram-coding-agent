import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskId } from '@gram/domain';
import { openDatabase } from '../database.js';
import { runMigrations } from '../migrator.js';
import {
  APPROVAL_TTL_MS,
  ApprovalAlreadyResolvedError,
  ApprovalHashMismatchError,
  ApprovalNotFoundError,
  ApprovalRepository,
} from './approval-repository.js';
import { TaskRepository } from './task-repository.js';

const databases: Array<{ close(): void }> = [];
const tempDirs: string[] = [];

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function setupMemory(): { db: ReturnType<typeof openDatabase>; taskId: TaskId } {
  const db = openDatabase(':memory:');
  databases.push(db);
  runMigrations(db);
  const task = new TaskRepository(db).create({
    goal: 'approval lifecycle',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
  });
  return { db, taskId: task.id };
}

function createTask(db: ReturnType<typeof openDatabase>): TaskId {
  return new TaskRepository(db).create({
    goal: 'approval lifecycle',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
  }).id;
}

describe('ApprovalRepository', () => {
  it('R1 request then approve then consume transitions to CONSUMED exactly once', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const requested = repo.request({ taskId, operationHash: 'op-r1' });
    expect(requested.status).toBe('PENDING');

    const approved = repo.approve(requested.id, 'op-r1');
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.expiresAt).not.toBeNull();

    const first = repo.consume(taskId, 'op-r1');
    expect(first).toBe(true);
    const second = repo.consume(taskId, 'op-r1');
    expect(second).toBe(false);

    const stored = repo.get(requested.id);
    expect(stored?.status).toBe('CONSUMED');
    expect(stored?.consumedAt).not.toBeNull();
  });

  it('R2 list for a task returns decoded camelCase rows', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const first = repo.request({ taskId, operationHash: 'op-a' });
    const second = repo.request({ taskId, operationHash: 'op-b' });

    const rows = repo.listForTask(taskId);
    expect(rows).toHaveLength(2);
    const ids = rows.map((row) => row.id).sort((a, b) => a - b);
    expect(ids).toEqual([first.id, second.id].sort((a, b) => a - b));
    for (const row of rows) {
      expect(row.taskId).toBe(taskId);
      expect(typeof row.operationHash).toBe('string');
      expect(typeof row.requestedAt).toBe('string');
      expect('requested_at' in row).toBe(false);
    }
    expect(APPROVAL_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('R3 consume with no row at all returns false and creates nothing', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    expect(repo.consume(taskId, 'missing-op')).toBe(false);
    expect(repo.listForTask(taskId)).toHaveLength(0);
  });

  it('R4 second consume of the same row returns false', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const created = repo.request({ taskId, operationHash: 'op-r4' });
    repo.approve(created.id, 'op-r4');
    expect(repo.consume(taskId, 'op-r4')).toBe(true);
    expect(repo.consume(taskId, 'op-r4')).toBe(false);
    expect(repo.get(created.id)?.status).toBe('CONSUMED');
  });

  it('R5 concurrent consume from two connections allows exactly one winner', () => {
    const dir = mkdtempSync(join(tmpdir(), 'approvals-r5-'));
    tempDirs.push(dir);
    const path = join(dir, 'r5.db');
    const db1 = openDatabase(path);
    const db2 = openDatabase(path);
    databases.push(db1, db2);
    runMigrations(db1);
    const taskId = createTask(db1);
    const repo1 = new ApprovalRepository(db1);
    const repo2 = new ApprovalRepository(db2);

    const created = repo1.request({ taskId, operationHash: 'op-r5' });
    repo1.approve(created.id, 'op-r5');

    const results = [repo1.consume(taskId, 'op-r5'), repo2.consume(taskId, 'op-r5')].sort();
    expect(results).toEqual([false, true]);
  });

  it('R6 same operationHash on a different taskId is rejected', () => {
    const { db } = setupMemory();
    const tasks = new TaskRepository(db);
    const taskA = tasks.create({ goal: 'a', taskType: 'CODING', publishMode: 'PULL_REQUEST' }).id;
    const taskB = tasks.create({ goal: 'b', taskType: 'CODING', publishMode: 'PULL_REQUEST' }).id;
    const repo = new ApprovalRepository(db);
    const created = repo.request({ taskId: taskA, operationHash: 'shared-op' });
    repo.approve(created.id, 'shared-op');
    expect(repo.consume(taskB, 'shared-op')).toBe(false);
    expect(repo.get(created.id)?.status).toBe('APPROVED');
  });

  it('R7 expired APPROVED row consumes false and transitions to EXPIRED', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const created = repo.request({ taskId, operationHash: 'op-r7' });
    repo.approve(created.id, 'op-r7');
    db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      created.id,
    );

    expect(repo.consume(taskId, 'op-r7')).toBe(false);
    expect(repo.get(created.id)?.status).toBe('EXPIRED');
  });

  it('R8 a new request after EXPIRED succeeds because lazy expiry clears the live pair', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const created = repo.request({ taskId, operationHash: 'op-r8' });
    repo.approve(created.id, 'op-r8');
    db.prepare("UPDATE approvals SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(
      created.id,
    );

    // Without the lazy APPROVED-to-EXPIRED step, this raw INSERT would be the
    // only path and the partial unique index would still see the stale
    // APPROVED row as live and reject it.
    let blocked = false;
    try {
      db.prepare(
        "INSERT INTO approvals(task_id, operation_hash, status, requested_at) VALUES (?, ?, 'PENDING', ?)",
      ).run(taskId, 'op-r8', new Date().toISOString());
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
      ) {
        blocked = true;
      } else {
        throw error;
      }
    }
    expect(blocked).toBe(true);

    const next = repo.request({ taskId, operationHash: 'op-r8' });
    expect(next.id).not.toBe(created.id);
    expect(next.status).toBe('PENDING');
    expect(repo.get(created.id)?.status).toBe('EXPIRED');
  });

  it('R9 a new request after DENIED succeeds', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const created = repo.request({ taskId, operationHash: 'op-r9' });
    repo.deny(created.id, 'op-r9');
    expect(repo.get(created.id)?.status).toBe('DENIED');

    const next = repo.request({ taskId, operationHash: 'op-r9' });
    expect(next.status).toBe('PENDING');
    expect(next.id).not.toBe(created.id);
  });

  it('R10 duplicate request while PENDING is live does not create a second row', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const first = repo.request({ taskId, operationHash: 'op-r10' });
    let second = first;
    expect(() => {
      second = repo.request({ taskId, operationHash: 'op-r10' });
    }).not.toThrow();
    expect(second.id).toBe(first.id);
    expect(repo.listForTask(taskId)).toHaveLength(1);
  });

  it('R11 approve with the wrong operationHash throws and leaves the row PENDING', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const created = repo.request({ taskId, operationHash: 'op-r11' });
    expect(() => repo.approve(created.id, 'wrong-hash')).toThrow(ApprovalHashMismatchError);
    try {
      repo.approve(created.id, 'wrong-hash');
    } catch (error) {
      expect(error).toBeInstanceOf(ApprovalHashMismatchError);
      expect((error as ApprovalHashMismatchError).name).toBe('ApprovalHashMismatchError');
    }
    expect(repo.get(created.id)?.status).toBe('PENDING');
  });

  it('R12 approve of a CONSUMED or DENIED row throws already-resolved', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);

    const consumed = repo.request({ taskId, operationHash: 'op-r12a' });
    repo.approve(consumed.id, 'op-r12a');
    expect(repo.consume(taskId, 'op-r12a')).toBe(true);
    expect(() => repo.approve(consumed.id, 'op-r12a')).toThrow(ApprovalAlreadyResolvedError);

    const denied = repo.request({ taskId, operationHash: 'op-r12b' });
    repo.deny(denied.id, 'op-r12b');
    expect(() => repo.approve(denied.id, 'op-r12b')).toThrow(ApprovalAlreadyResolvedError);

    expect(() => repo.approve(999999, 'op-r12a')).toThrow(ApprovalNotFoundError);
  });

  it('R13 an illegal status value is rejected by the CHECK constraint', () => {
    const { db, taskId } = setupMemory();
    expect(() =>
      db
        .prepare(
          "INSERT INTO approvals(task_id, operation_hash, status, requested_at) VALUES (?, ?, 'BOGUS', ?)",
        )
        .run(taskId, 'op-r13', new Date().toISOString()),
    ).toThrow();
  });

  it('R12b deny of a non-PENDING row throws already-resolved', () => {
    const { db, taskId } = setupMemory();
    const repo = new ApprovalRepository(db);
    const created = repo.request({ taskId, operationHash: 'op-deny' });
    repo.approve(created.id, 'op-deny');
    expect(() => repo.deny(created.id, 'op-deny')).toThrow(ApprovalAlreadyResolvedError);
  });
});
