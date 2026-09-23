import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openDatabase,
  RepositoryRepository,
  runMigrations,
  TaskRepository,
  WorkspaceRepository,
} from '@gram/persistence';
import { CodeSearch } from './code-search.js';
import { DiffService } from './diff-service.js';
import { WorkspacePathGuard } from './workspace-path-guard.js';

const roots: string[] = [];
const databases: Array<{ close(): void }> = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-code-search-'));
  roots.push(root);
  return root;
}

function setup() {
  const root = tempRoot();
  const workspaceRoot = join(root, 'worktree');
  mkdirSync(join(workspaceRoot, 'src'), { recursive: true });
  writeFileSync(join(workspaceRoot, 'src', 'app.ts'), 'const needle = true;\n');

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
    goal: 'search task code',
    taskType: 'CODING',
    publishMode: 'PULL_REQUEST',
    repoId: 84722133,
  });
  const workspaces = new WorkspaceRepository(db);
  workspaces.create({
    taskId: task.id,
    repoId: 84722133,
    linuxPath: workspaceRoot,
    branch: 'fix/task-000001-search-code',
    headSha: 'a'.repeat(40),
  });

  return { workspaceRoot, task, guard: new WorkspacePathGuard(workspaces) };
}

afterEach(() => {
  while (databases.length) databases.pop()?.close();
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('CodeSearch', () => {
  it('runs rg --json through the command runner and returns structured matches', async () => {
    const { workspaceRoot, task, guard } = setup();
    const record = JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/app.ts' },
        lines: { text: 'const needle = true;\n' },
        line_number: 3,
        submatches: [{ match: { text: 'needle' }, start: 6, end: 12 }],
      },
    });
    const run = vi.fn(async () => ({
      stdout: `${record}\n`,
    }));
    const search = new CodeSearch({ guard, commands: { run } });

    const matches = await search.search({
      taskId: task.id,
      pattern: 'needle',
      relativePath: 'src',
    });

    expect(run).toHaveBeenCalledWith({
      taskId: task.id,
      cwd: workspaceRoot,
      category: 'FILESYSTEM',
      executable: 'rg',
      args: ['--json', 'needle', 'src'],
    });
    expect(matches).toEqual([
      {
        path: 'src/app.ts',
        line: 3,
        column: 7,
        text: 'const needle = true;\n',
      },
    ]);
  });
});

describe('DiffService', () => {
  it('runs path-scoped git diff through the command runner', async () => {
    const { workspaceRoot, task, guard } = setup();
    const run = vi.fn(async () => ({ stdout: 'diff --git a/src/app.ts b/src/app.ts\n' }));
    const diffs = new DiffService({ guard, commands: { run } });

    const result = await diffs.diff(task.id, 'src/app.ts');

    expect(run).toHaveBeenCalledWith({
      taskId: task.id,
      cwd: workspaceRoot,
      category: 'GIT',
      executable: 'git',
      args: ['diff', '--', 'src/app.ts'],
    });
    expect(result).toContain('diff --git');
  });
});
