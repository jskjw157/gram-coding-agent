import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  WorkspaceRepository,
} from '@gram/persistence';
import {
  WorkspacePathEscapeError,
  WorkspacePathGuard,
} from './workspace-path-guard.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-filesystem-'));
  roots.push(root);
  return root;
}

function setup() {
  const root = tempRoot();
  const workspaceRoot = join(root, 'worktree');
  const outsideRoot = join(root, 'outside');
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'safe.ts'), 'export const safe = true;\n');
  writeFileSync(join(outsideRoot, 'secret.txt'), 'outside\n');

  const db = openDatabase(join(root, 'state.db'));
  databases.push(db);
  runMigrations(db);

  const repositories = new RepositoryRepository(db);
  repositories.upsert({
    githubRepositoryId: 84722133,
    owner: 'company',
    name: 'mamf-web',
    defaultBranch: 'main',
    localBasePath: join(root, 'canonical'),
  });

  const tasks = new TaskRepository(db);
  const task = tasks.create({
    goal: 'edit safe code',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId: 84722133,
  });

  const workspaces = new WorkspaceRepository(db);
  workspaces.create({
    taskId: task.id,
    repoId: 84722133,
    linuxPath: workspaceRoot,
    branch: 'fix/task-000001-safe-code',
    headSha: 'a'.repeat(40),
  });

  return {
    root,
    workspaceRoot,
    outsideRoot,
    task,
    guard: new WorkspacePathGuard(workspaces),
  };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('WorkspacePathGuard', () => {
  it('allows a normal existing worktree-relative file', () => {
    const { workspaceRoot, task, guard } = setup();

    expect(guard.resolveExisting(task.id, 'src/safe.ts')).toBe(
      join(workspaceRoot, 'src', 'safe.ts'),
    );
  });

  it('rejects parent traversal outside the task workspace', () => {
    const { task, guard } = setup();

    expect(() => guard.resolveExisting(task.id, '../../etc/passwd')).toThrow(
      WorkspacePathEscapeError,
    );
  });

  it('rejects absolute paths', () => {
    const { task, guard } = setup();

    expect(() => guard.resolveExisting(task.id, '/etc/passwd')).toThrow(
      WorkspacePathEscapeError,
    );
  });

  it('rejects an existing symlink that escapes the task workspace', () => {
    const { workspaceRoot, outsideRoot, task, guard } = setup();
    symlinkSync(outsideRoot, join(workspaceRoot, 'escape'));

    expect(() => guard.resolveExisting(task.id, 'escape/secret.txt')).toThrow(
      WorkspacePathEscapeError,
    );
  });

  it('checks the nearest existing parent for new-file writes and rejects symlink escape', () => {
    const { workspaceRoot, outsideRoot, task, guard } = setup();
    symlinkSync(outsideRoot, join(workspaceRoot, 'escape'));

    expect(() => guard.resolveForWrite(task.id, 'escape/new/deep/file.ts')).toThrow(
      WorkspacePathEscapeError,
    );
  });

  it('allows a new file whose nearest existing parent remains inside the workspace', () => {
    const { workspaceRoot, task, guard } = setup();

    expect(guard.resolveForWrite(task.id, 'src/new/deep/file.ts')).toBe(
      join(workspaceRoot, 'src', 'new', 'deep', 'file.ts'),
    );
  });
});
