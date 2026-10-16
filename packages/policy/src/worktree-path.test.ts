import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertTaskWorktreeTarget } from './worktree-path.js';

const REASON = 'worktree target must be within the agent task-worktree layout';

const roots: string[] = [];

function tempHome(): string {
  const root = mkdtempSync(join(tmpdir(), 'gram-worktree-path-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  let root: string | undefined;
  while ((root = roots.pop()) !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('assertTaskWorktreeTarget', () => {
  it('rejects traversal and symlinked worktree parents before add', () => {
    const home = tempHome();
    const taskId = 'task-000001';
    const repoId = 7;
    mkdirSync(join(home, '.gram-agent', 'worktrees', String(repoId)), { recursive: true });

    // ../../ escape
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId,
        repoId,
        target: join(home, '.gram-agent', 'worktrees', String(repoId), '..', '..', 'escape'),
        mode: 'add',
      }),
    ).toThrow(REASON);

    // sibling-prefix path (naive startsWith would pass)
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId,
        repoId,
        target: join(home, '.gram-agent', 'worktrees-evil', String(repoId), taskId),
        mode: 'add',
      }),
    ).toThrow(REASON);

    // traversing taskId
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId: '../../escape',
        repoId,
        target: join(home, '.gram-agent', 'worktrees', String(repoId), taskId),
        mode: 'add',
      }),
    ).toThrow(REASON);

    // unsafe repoId
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId,
        repoId: Number.NaN,
        target: join(home, '.gram-agent', 'worktrees', '7', taskId),
        mode: 'add',
      }),
    ).toThrow(REASON);

    // symlinked parent (canonical containment: worktrees/<repoId> is a symlink)
    const evil = join(home, 'evil-target');
    mkdirSync(evil, { recursive: true });
    const symRepoId = 555;
    const linkParent = join(home, '.gram-agent', 'worktrees', String(symRepoId));
    symlinkSync(evil, linkParent);
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId,
        repoId: symRepoId,
        target: join(home, '.gram-agent', 'worktrees', String(symRepoId), taskId),
        mode: 'add',
      }),
    ).toThrow(REASON);

    // valid fresh add target does not throw
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId,
        repoId,
        target: join(home, '.gram-agent', 'worktrees', String(repoId), taskId),
        mode: 'add',
      }),
    ).not.toThrow();
    expect(existsSync(join(home, '.gram-agent', 'worktrees', String(repoId), taskId))).toBe(false);
  });

  it('rejects an outside or symlinked remove target', () => {
    const home = tempHome();
    const taskId = 'task-000002';
    const repoId = 11;
    const parent = join(home, '.gram-agent', 'worktrees', String(repoId));
    mkdirSync(parent, { recursive: true });

    // outside target
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId,
        repoId,
        target: join(home, 'somewhere-else', taskId),
        mode: 'remove',
      }),
    ).toThrow(REASON);

    // missing target
    expect(() =>
      assertTaskWorktreeTarget({
        homeDir: home,
        taskId,
        repoId,
        target: join(parent, taskId),
        mode: 'remove',
      }),
    ).toThrow(REASON);

    // symlink target
    const realDir = join(home, 'real-dir');
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, 'x.txt'), 'x\n');
    const linkTarget = join(parent, taskId);
    symlinkSync(realDir, linkTarget);
    expect(() =>
      assertTaskWorktreeTarget({ homeDir: home, taskId, repoId, target: linkTarget, mode: 'remove' }),
    ).toThrow(REASON);
    rmSync(linkTarget, { force: true });

    // existing ordinary task directory is accepted
    mkdirSync(linkTarget, { recursive: true });
    writeFileSync(join(linkTarget, 'x.txt'), 'x\n');
    expect(() =>
      assertTaskWorktreeTarget({ homeDir: home, taskId, repoId, target: linkTarget, mode: 'remove' }),
    ).not.toThrow();
  });
});
