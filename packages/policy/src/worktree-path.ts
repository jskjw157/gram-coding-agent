import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const WORKTREE_PATH_REASON =
  'worktree target must be within the agent task-worktree layout';

const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;

// Walk up from `start` to the nearest existing ancestor. Returns its
// canonical location plus the non-existent tail segments (outermost first).
// The tail cannot contain a symlink (it does not exist), but anything
// ambiguous still fails closed with the shared reason.
function splitToExisting(path: string): { canonicalExisting: string; pending: string[] } {
  const pending: string[] = [];
  let current = path;
  for (let depth = 0; depth < 512; depth += 1) {
    try {
      return { canonicalExisting: realpathSync(current), pending };
    } catch {
      const parent = dirname(current);
      if (parent === current) throw new Error(WORKTREE_PATH_REASON);
      pending.unshift(basename(current));
      current = parent;
    }
  }
  throw new Error(WORKTREE_PATH_REASON);
}

function joinCanonical(base: string, pending: readonly string[]): string {
  for (const segment of pending) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(WORKTREE_PATH_REASON);
    }
  }
  return pending.length === 0 ? base : join(base, ...pending);
}

// Canonical form of the candidate's parent directory. For `remove` the
// parent must exist and is resolved exactly; for `add` the parent may not
// exist yet (pre-mkdir validation), so the nearest existing ancestor is
// resolved and the non-existent tail is appended lexically. Starting the
// walk FROM the parent itself means an existing symlinked parent is still
// resolved through and rejected.
function canonicalizeParent(parentDir: string, mode: 'add' | 'remove'): string {
  if (mode === 'remove') {
    try {
      return realpathSync(parentDir);
    } catch {
      throw new Error(WORKTREE_PATH_REASON);
    }
  }
  const { canonicalExisting, pending } = splitToExisting(parentDir);
  return joinCanonical(canonicalExisting, pending);
}

// Canonical form of the home prefix. The home itself may not exist yet on a
// first-ever `add`, so the same nearest-ancestor tolerance applies; the
// comparison against the likewise-resolved candidate parent keeps the check
// exact whenever no symlink intervenes.
function canonicalizeHomePrefix(homeDir: string): string {
  const { canonicalExisting, pending } = splitToExisting(homeDir);
  return joinCanonical(canonicalExisting, pending);
}

export function assertTaskWorktreeTarget(options: {
  readonly homeDir: string;
  readonly taskId: string;
  readonly repoId: number;
  readonly target: string;
  readonly mode: 'add' | 'remove';
}): void {
  const fail = (): Error => new Error(WORKTREE_PATH_REASON);
  const { homeDir, taskId, repoId, target, mode } = options;

  // 1. Identity safety: taskId and repoId are interpolated into the path,
  // so a traversing taskId (../../escape) must never produce a valid path.
  if (typeof homeDir !== 'string' || homeDir.length === 0) throw fail();
  if (typeof taskId !== 'string' || TASK_ID_RE.test(taskId) === false) throw fail();
  if (typeof repoId !== 'number' || Number.isSafeInteger(repoId) === false || repoId <= 0) {
    throw fail();
  }
  if (typeof target !== 'string' || target.length === 0) throw fail();

  // 2. Lexical containment. The target must be an absolute POSIX path that
  // resolves to exactly the expected task-worktree child. Containment is
  // proven with relative(), never with a bare startsWith(root) comparison:
  // sibling-prefix paths like "<root>-evil" pass a naive startsWith.
  if (isAbsolute(target) === false || target.startsWith('/') === false) throw fail();
  const root = resolve(homeDir, '.gram-agent', 'worktrees');
  const expected = resolve(root, String(repoId), taskId);
  const candidate = resolve(target);
  if (candidate !== expected) throw fail();
  const rel = relative(root, candidate);
  if (rel.length === 0) throw fail();
  if (rel === '..') throw fail();
  if (rel.startsWith(`..${sep}`)) throw fail();
  if (isAbsolute(rel)) throw fail();

  // 3. Canonical containment. Resolve the candidate's PARENT and the home
  // through the filesystem and require the canonical parent to equal the
  // canonical repo-scoped layout directory. This rejects symlinked
  // intermediates (.gram-agent, worktrees, or the repoId directory pointing
  // elsewhere).
  //
  // Fresh-layout tolerance: WorktreeService validates BEFORE mkdirSync, so
  // for `add` the parent chain may not exist yet. realpathSync is therefore
  // applied to the nearest EXISTING ancestor (starting from the parent
  // itself, so an existing symlinked parent is still resolved and rejected)
  // and the non-existent remainder — which cannot contain a symlink — is
  // compared lexically. Anything ambiguous fails closed. For `remove` the
  // target must already exist, so the parent is required to resolve exactly
  // as specified (missing or unresolvable parents fail closed).
  //
  // Boundary note: this check cannot eliminate a check-to-spawn symlink
  // race between validation and the subsequent git spawn. Keep the parent
  // directory private (mode 0o700, owned by the agent user) so only the
  // agent can win that race; the guard makes accidental/off-layout use
  // impossible but does not claim the race is airtight.
  const parentDir = dirname(candidate);
  const canonicalParent = canonicalizeParent(parentDir, mode);
  const canonicalHomePrefix = canonicalizeHomePrefix(homeDir);
  const expectedCanonicalParent = join(
    canonicalHomePrefix,
    '.gram-agent',
    'worktrees',
    String(repoId),
  );
  if (canonicalParent !== expectedCanonicalParent) throw fail();

  // 4. Mode-specific checks.
  if (mode === 'add') {
    // Adding must target a fresh path: reject an already-existing target,
    // including a symlink (lstat succeeds for symlinks, even dangling
    // ones via lstat; dangling readlink targets still count as present).
    try {
      lstatSync(candidate);
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code: unknown }).code)
          : undefined;
      if (code === 'ENOENT') return;
      throw fail();
    }
    throw fail();
  }

  // Removal deletes a directory, so it gets the stricter check: the target
  // must already exist, must not be a symlink, must be a directory, and its
  // canonical location must equal the expected canonical child.
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(target);
  } catch {
    throw fail();
  }
  if (stat.isSymbolicLink()) throw fail();
  if (stat.isDirectory() === false) throw fail();
  let canonicalTarget: string;
  try {
    canonicalTarget = realpathSync(target);
  } catch {
    throw fail();
  }
  const expectedCanonicalTarget = join(expectedCanonicalParent, taskId);
  if (canonicalTarget !== expectedCanonicalTarget) throw fail();
}
