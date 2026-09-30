import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import * as persistence from '../index.js';

const directories: string[] = [];
const databases: Database.Database[] = [];

function open(path: string) {
  const db = persistence.openDatabase(path);
  databases.push(db);
  return db;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'gram-coding-steps-'));
  directories.push(directory);
  const path = join(directory, 'state.db');
  const db = open(path);
  persistence.runMigrations(db);
  const tasks = new persistence.TaskRepository(db);
  const workspaces = new persistence.WorkspaceRepository(db);
  new persistence.RepositoryRepository(db).upsert({
    githubRepositoryId: 42, owner: 'acme', name: 'web', defaultBranch: 'main', localBasePath: directory,
  });
  const task = tasks.create({ goal: 'change the source', taskType: 'CODING', publishMode: 'PULL_REQUEST', repoId: 42 });
  const workspace = workspaces.create({
    taskId: task.id, repoId: 42, linuxPath: join(directory, 'workspace'), branch: 'task/source-change',
  });
  expect(persistence.CodingStepRepository).toBeTypeOf('function');
  const steps = new persistence.CodingStepRepository(db);
  const input: persistence.CreateCodingStepInput = {
    id: randomUUID(), taskId: task.id, workspaceId: workspace.id, workspacePath: workspace.linuxPath,
    branch: workspace.branch, phase: 'INSTRUCTIONS', runId: randomUUID(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  return { db, path, tasks, task, workspace, workspaces, steps, input };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let directory: string | undefined;
  while ((directory = directories.pop()) !== undefined) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CodingStepRepository identity', () => {
  it('persists only the requested identity and timestamps and returns undefined for missing steps', () => {
    const { steps, input } = fixture();
    const row = steps.create(input);

    expect(row).toEqual({
      ...input, state: 'PENDING', createdAt: expect.any(String), updatedAt: expect.any(String), finishedAt: null,
    });
    expect(new Date(row.createdAt).toISOString()).toBe(row.createdAt);
    expect(row.updatedAt).toBe(row.createdAt);
    expect(steps.get(input.id)).toEqual(row);
    expect(steps.get(randomUUID())).toBeUndefined();
  });

  it('does not replace an existing step identity when a repeated ID is created', () => {
    const { steps, input } = fixture();
    const row = steps.create(input);

    expect(() => steps.create({ ...input, phase: 'MODIFY', runId: randomUUID() })).toThrow();
    expect(steps.get(input.id)).toEqual(row);
  });

  it('rejects binding to another task workspace or a changed workspace path or branch', () => {
    const { tasks, steps, input } = fixture();
    const another = tasks.create({ goal: 'another task', taskType: 'CODING', publishMode: 'PULL_REQUEST', repoId: 42 });

    expect(() => steps.create({ ...input, taskId: another.id })).toThrow(/workspace/i);
    expect(() => steps.create({ ...input, workspaceId: input.workspaceId + 1 })).toThrow(/workspace/i);
    expect(() => steps.create({ ...input, workspacePath: '/different/workspace' })).toThrow(/workspace/i);
    expect(() => steps.create({ ...input, branch: 'different-branch' })).toThrow(/workspace/i);
    expect(steps.get(input.id)).toBeUndefined();
  });

  it('rejects invalid or noncanonical expiry timestamps before persisting a step', () => {
    const { steps, input } = fixture();

    for (const expiresAt of ['invalid', '2026-12-01', '2026-12-01T00:00:00+03:00']) {
      expect(() => steps.create({ ...input, expiresAt })).toThrow(/expiresAt/i);
      expect(steps.get(input.id)).toBeUndefined();
    }
  });

  it('retains SQLite foreign key protection for task and workspace references', () => {
    const { db, steps, input } = fixture();
    steps.create(input);

    expect(() => db.prepare('UPDATE coding_steps SET task_id = ? WHERE id = ?').run(randomUUID(), input.id))
      .toThrow(/FOREIGN KEY/);
    expect(() => db.prepare('UPDATE coding_steps SET workspace_id = ? WHERE id = ?').run(-1, input.id))
      .toThrow(/FOREIGN KEY/);
  });
});

describe('CodingStepRepository lifecycle', () => {
  it('allows only one pending step per task across database connections', () => {
    const { path, steps, input } = fixture();
    const second = new persistence.CodingStepRepository(open(path));
    steps.create(input);

    expect(() => second.create({ ...input, id: randomUUID() })).toThrow(/UNIQUE/);
    expect(steps.get(input.id)?.state).toBe('PENDING');
  });

  it('claims a pending step once across database connections without changing its identity', () => {
    const { path, steps, input } = fixture();
    const second = new persistence.CodingStepRepository(open(path));
    const original = steps.create(input);

    expect(steps.claim(input.id, input.taskId, input.runId)).toBe(true);
    expect(second.claim(input.id, input.taskId, input.runId)).toBe(false);
    expect(steps.get(input.id)).toEqual({ ...original, state: 'APPLYING', updatedAt: expect.any(String) });
    expect(() => second.create({ ...input, id: randomUUID() })).toThrow(/UNIQUE/);
  });

  it('does not claim unknown, wrong-task, or wrong-run requests', () => {
    const { tasks, steps, input } = fixture();
    const other = tasks.create({ goal: 'other task', taskType: 'CODING', publishMode: 'PULL_REQUEST' });
    const original = steps.create(input);

    expect(steps.claim(randomUUID(), input.taskId, input.runId)).toBe(false);
    expect(steps.claim(input.id, other.id, input.runId)).toBe(false);
    expect(steps.claim(input.id, input.taskId, randomUUID())).toBe(false);
    expect(steps.get(input.id)).toEqual(original);
  });

  it('does not claim an expired step', () => {
    const { steps, input } = fixture();
    const original = steps.create({ ...input, expiresAt: new Date(Date.now() - 1).toISOString() });

    expect(steps.claim(input.id, input.taskId, input.runId)).toBe(false);
    expect(steps.get(input.id)).toEqual(original);
  });

  it('finishes claimed steps and permits a new phase without permitting replay', () => {
    const { steps, input } = fixture();
    const original = steps.create(input);
    steps.claim(input.id, input.taskId, input.runId);
    steps.finish(input.id, input.runId, 'SUCCEEDED');

    const finished = steps.get(input.id);
    expect(finished).toEqual({
      ...original, state: 'SUCCEEDED', updatedAt: expect.any(String), finishedAt: expect.any(String),
    });
    expect(finished?.finishedAt).toBe(finished?.updatedAt);
    expect(steps.claim(input.id, input.taskId, input.runId)).toBe(false);
    expect(() => steps.finish(input.id, input.runId, 'SUCCEEDED')).toThrow(/transition/);
    expect(() => steps.finish(input.id, input.runId, 'FAILED')).toThrow();
    expect(steps.get(input.id)).toEqual(finished);
    expect(steps.create({ ...input, id: randomUUID(), phase: 'ANALYZE' }).state).toBe('PENDING');
  });

  it('rejects incompatible, wrong-run and unknown terminal transitions without mutation', () => {
    const { steps, input } = fixture();
    const original = steps.create(input);

    expect(() => steps.finish(input.id, input.runId, 'SUCCEEDED')).toThrow(/transition/);
    expect(() => steps.finish(input.id, randomUUID(), 'FAILED')).toThrow(/transition/);
    expect(() => steps.finish(randomUUID(), input.runId, 'INTERRUPTED')).toThrow(/transition/);
    expect(() => steps.finish(input.id, input.runId, 'PENDING' as persistence.CodingStepTerminalState)).toThrow(/transition/);
    expect(steps.get(input.id)).toEqual(original);
  });

  it.each(['FAILED', 'INTERRUPTED'] as const)('can mark pending and applying steps %s', (state) => {
    const { steps, input } = fixture();
    steps.create(input);
    steps.finish(input.id, input.runId, state);
    expect(steps.get(input.id)?.state).toBe(state);
    expect(steps.get(input.id)?.finishedAt).toEqual(expect.any(String));
    expect(steps.claim(input.id, input.taskId, input.runId)).toBe(false);

    const next = { ...input, id: randomUUID() };
    steps.create(next);
    steps.claim(next.id, next.taskId, next.runId);
    steps.finish(next.id, next.runId, state);
    expect(steps.get(next.id)?.state).toBe(state);
    expect(steps.claim(next.id, next.taskId, next.runId)).toBe(false);
  });

  it('invalidates pending and applying steps after reopening while retaining terminal records', () => {
    const { path, db, tasks, workspaces, task, steps, input } = fixture();
    const completed = steps.create(input);
    steps.claim(input.id, input.taskId, input.runId);
    steps.finish(input.id, input.runId, 'SUCCEEDED');
    const terminal = steps.get(completed.id);
    const applying = { ...input, id: randomUUID(), phase: 'ANALYZE' as const };
    steps.create(applying);
    steps.claim(applying.id, applying.taskId, applying.runId);
    const anotherTask = tasks.create({ goal: 'pending task', taskType: 'CODING', publishMode: 'PULL_REQUEST', repoId: 42 });
    const anotherWorkspace = workspaces.create({
      taskId: anotherTask.id, repoId: 42, linuxPath: '/other/workspace', branch: 'task/other',
    });
    const pending = {
      ...input, id: randomUUID(), taskId: anotherTask.id, workspaceId: anotherWorkspace.id,
      workspacePath: anotherWorkspace.linuxPath, branch: anotherWorkspace.branch,
    };
    steps.create(pending);
    db.close();
    databases.splice(databases.indexOf(db), 1);

    const reopened = open(path);
    persistence.runMigrations(reopened);
    const restarted = new persistence.CodingStepRepository(reopened);
    restarted.interruptPending();

    for (const interrupted of [applying, pending]) {
      expect(restarted.get(interrupted.id)).toMatchObject({
        ...interrupted, state: 'INTERRUPTED', finishedAt: expect.any(String),
      });
      expect(restarted.claim(interrupted.id, interrupted.taskId, interrupted.runId)).toBe(false);
      expect(() => restarted.finish(interrupted.id, interrupted.runId, 'SUCCEEDED')).toThrow();
    }
    expect(restarted.get(completed.id)).toEqual(terminal);
    expect(new persistence.TaskRepository(reopened).get(task.id)).toEqual(task);
    const interrupted = restarted.get(applying.id);
    restarted.interruptPending();
    expect(restarted.get(applying.id)).toEqual(interrupted);
    expect(restarted.create({ ...input, id: randomUUID(), runId: randomUUID() }).state).toBe('PENDING');
  });
});
