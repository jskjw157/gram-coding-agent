import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import { FileService } from './file-service.js';
import {
  ExactPatchMismatchError,
  PatchService,
} from './patch-service.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-file-service-'));
  roots.push(root);
  return root;
}

function setup() {
  const root = tempRoot();
  const workspaceRoot = join(root, 'worktree');
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(
    join(workspaceRoot, 'src', 'app.ts'),
    'const oldValue = 1;\nexport { oldValue };\n',
  );

  const db = openDatabase(join(root, 'state.db'));
  databases.push(db);
  runMigrations(db);
  new RepositoryRepository(db).upsert({
    githubRepositoryId: 84722133,
    owner: 'company',
    name: 'mamf-web',
    defaultBranch: 'main',
    localBasePath: join(root, 'canonical'),
  });
  const task = new TaskRepository(db).create({
    goal: 'edit task file',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId: 84722133,
  });
  const workspaces = new WorkspaceRepository(db);
  workspaces.create({
    taskId: task.id,
    repoId: 84722133,
    linuxPath: workspaceRoot,
    branch: 'fix/task-000001-edit-task-file',
    headSha: 'a'.repeat(40),
  });

  const guard = new WorkspacePathGuard(workspaces);
  const files = new FileService(guard);
  const patches = new PatchService(files);
  return { workspaceRoot, task, files, patches };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('FileService', () => {
  it('reads and writes only task-relative workspace paths', () => {
    const { workspaceRoot, task, files } = setup();

    expect(files.readText(task.id, 'src/app.ts')).toContain('oldValue');

    files.writeText(task.id, 'src/generated/deep/new.ts', 'export const generated = true;\n');

    expect(
      readFileSync(join(workspaceRoot, 'src', 'generated', 'deep', 'new.ts'), 'utf8'),
    ).toBe('export const generated = true;\n');
    expect(() => files.readText(task.id, '../../etc/passwd')).toThrow();
  });
});

describe('PatchService', () => {
  it('fails closed when the exact expected old hunk is absent', () => {
    const { workspaceRoot, task, patches } = setup();
    const original = readFileSync(join(workspaceRoot, 'src', 'app.ts'), 'utf8');

    expect(() =>
      patches.patchExact(task.id, 'src/app.ts', 'const missing = 1;', 'const changed = 2;'),
    ).toThrow(ExactPatchMismatchError);

    expect(readFileSync(join(workspaceRoot, 'src', 'app.ts'), 'utf8')).toBe(original);
  });

  it('replaces the exact expected hunk when it exists', () => {
    const { workspaceRoot, task, patches } = setup();

    patches.patchExact(
      task.id,
      'src/app.ts',
      'const oldValue = 1;',
      'const oldValue = 2;',
    );

    expect(readFileSync(join(workspaceRoot, 'src', 'app.ts'), 'utf8')).toContain(
      'const oldValue = 2;',
    );
  });
});
