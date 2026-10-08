import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { TaskId } from '@gram/domain';
import type { RepositoryRepository, StoredWorkspace, WorkspaceRepository } from '@gram/persistence';
import { assertTaskWorktreeTarget } from '@gram/policy';

export type WorkspaceRecoveryTarget = Pick<
  StoredWorkspace,
  'taskId' | 'repoId' | 'linuxPath' | 'branch'
>;
export interface WorkspaceRecoveryGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export interface WorkspaceRecoveryGitRunner {
  // Structurally compatible with the existing policy-gated CommandRunner.
  // Composition must supply that boundary, never a direct process executor.
  run(request: {
    taskId: string;
    cwd: string;
    category: 'GIT';
    executable: 'git';
    args: readonly string[];
  }): Promise<WorkspaceRecoveryGitResult>;
}
export interface WorkspaceRecoveryOptions {
  taskId: TaskId;
  homeDir: string;
  workspaces: Pick<WorkspaceRepository, 'getByTaskId'>;
  repositories: Pick<RepositoryRepository, 'getById'>;
  runner: WorkspaceRecoveryGitRunner;
}
export interface WorkspaceRecoveryAssessment {
  state: 'CLEAN' | 'MISSING' | 'DIRTY' | 'UNPUSHED' | 'CONFLICT' | 'UNKNOWN';
  exists: boolean | null;
  branch: string | null;
  headSha: string | null;
  dirty: boolean | null;
  /** Compared with the LOCAL cached upstream; never fresh remote confirmation. */
  unpushed: boolean | null;
  indexLockPresent: boolean | null;
  expectedBranchMatches: boolean | null;
  reasons: readonly WorkspaceRecoveryReason[];
}

export type WorkspaceRecoveryReason =
  | 'WORKSPACE_BINDING_MISMATCH'
  | 'WORKSPACE_UNREGISTERED'
  | 'WORKSPACE_PATH_INVALID'
  | 'WORKSPACE_MISSING'
  | 'GIT_METADATA_CONFLICT'
  | 'GIT_METADATA_UNAVAILABLE'
  | 'INDEX_LOCK_PRESENT'
  | 'POLICY_BLOCKED'
  | 'GIT_FAILED'
  | 'GIT_DIAGNOSTIC'
  | 'INVALID_GIT_OUTPUT'
  | 'UNSUPPORTED_GIT_CONFIG'
  | 'SUBMODULES_UNASSESSED'
  | 'SHALLOW_REPOSITORY'
  | 'UNSUPPORTED_GIT_LAYOUT'
  | 'BRANCH_MISMATCH'
  | 'DETACHED_HEAD'
  | 'UNBORN_HEAD'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UNMERGED_CHANGES'
  | 'GIT_OPERATION_IN_PROGRESS'
  | 'GIT_STATE_CHANGED'
  | 'INSPECTION_FAILED'
  | 'UNSUPPORTED_INDEX_FLAGS'
  | 'SPLIT_INDEX_UNSUPPORTED';

class InspectionFailure extends Error {
  constructor(
    readonly reason: WorkspaceRecoveryReason,
    readonly conflict = false,
  ) {
    super(reason);
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function statIfPresent(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function plainDirectory(path: string): string {
  const stat = statIfPresent(path);
  if (stat === undefined) throw new InspectionFailure('GIT_METADATA_UNAVAILABLE');
  if (!stat.isDirectory() || realpathSync(path) !== resolve(path)) {
    throw new InspectionFailure('GIT_METADATA_CONFLICT', true);
  }
  return path;
}

function plainFile(path: string, required = true): void {
  const stat = statIfPresent(path);
  if (stat === undefined && !required) return;
  if (stat === undefined) throw new InspectionFailure('GIT_METADATA_UNAVAILABLE');
  if (!stat.isFile() || stat.nlink !== 1n)
    throw new InspectionFailure('GIT_METADATA_CONFLICT', true);
}

function pointerText(path: string): string {
  plainFile(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.nlink !== 1) {
      throw new InspectionFailure('GIT_METADATA_CONFLICT', true);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

interface GitLayout {
  gitDir: string;
  commonDir: string;
  dotGit: string;
}

function gitLayout(workspace: WorkspaceRecoveryTarget, repoPath: string): GitLayout {
  const dotGit = join(realpathSync(workspace.linuxPath), '.git');
  const stat = statIfPresent(dotGit);
  if (stat === undefined) throw new InspectionFailure('GIT_METADATA_UNAVAILABLE');
  let gitDir: string;
  let commonDir: string;
  if (stat.isDirectory()) {
    gitDir = commonDir = plainDirectory(dotGit);
    if (statIfPresent(join(gitDir, 'commondir')) !== undefined) {
      throw new InspectionFailure('GIT_METADATA_CONFLICT', true);
    }
  } else {
    const pointer = /^gitdir: ([^\r\n\0]+)\r?\n?$/.exec(pointerText(dotGit))?.[1];
    commonDir = plainDirectory(join(realpathSync(repoPath), '.git'));
    plainDirectory(join(commonDir, 'worktrees'));
    // #46 creates this exact task-UUID administrative directory. A different
    // task, relocated layout, or leftover ambiguous registration is a conflict.
    const expected = join(commonDir, 'worktrees', workspace.taskId);
    if (pointer === undefined || resolve(dirname(dotGit), pointer) !== expected) {
      throw new InspectionFailure('GIT_METADATA_CONFLICT', true);
    }
    gitDir = plainDirectory(expected);
    const common = pointerText(join(gitDir, 'commondir')).replace(/\r?\n$/, '');
    const backlink = pointerText(join(gitDir, 'gitdir')).replace(/\r?\n$/, '');
    if (
      /[\r\n\0]/.test(common + backlink) ||
      resolve(gitDir, common) !== commonDir ||
      resolve(gitDir, backlink) !== dotGit
    ) {
      throw new InspectionFailure('GIT_METADATA_CONFLICT', true);
    }
  }
  for (const path of [join(gitDir, 'HEAD'), join(gitDir, 'index'), join(commonDir, 'config')])
    plainFile(path, false);
  // Do not follow alternate object stores or legacy grafted history.
  for (const path of [
    join(commonDir, 'objects', 'info', 'alternates'),
    join(commonDir, 'info', 'grafts'),
  ]) {
    if (statIfPresent(path) !== undefined) throw new InspectionFailure('UNSUPPORTED_GIT_LAYOUT');
  }
  return { gitDir, commonDir, dotGit };
}

const operationMarkers = [
  'MERGE_HEAD',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'REBASE_HEAD',
  'rebase-apply',
  'rebase-merge',
  'sequencer',
  'BISECT_START',
] as const;

function assertUnsplitIndex(layout: GitLayout): void {
  // Git renews sharedindex.* mtime when READING a split index, even with
  // --no-optional-locks. Inspect names in this task's validated git-dir first;
  // do not run an index-reading Git command to discover the split layout.
  if (readdirSync(layout.gitDir).some((name) => name.startsWith('sharedindex.'))) {
    throw new InspectionFailure('SPLIT_INDEX_UNSUPPORTED');
  }
}

function metadataStamp(layout: GitLayout): string {
  return JSON.stringify(
    [
      layout.dotGit,
      join(layout.gitDir, 'HEAD'),
      join(layout.gitDir, 'index'),
      join(layout.gitDir, 'commondir'),
      join(layout.gitDir, 'gitdir'),
      ...operationMarkers.map((name) => join(layout.gitDir, name)),
      join(layout.commonDir, 'config'),
      join(layout.commonDir, 'packed-refs'),
    ].map((path) => {
      const stat = statIfPresent(path);
      return stat === undefined
        ? null
        : [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
    }),
  );
}

interface ParsedStatus {
  branch: string | null;
  headSha: string | null;
  dirty: boolean;
  unpushed: boolean | null;
  unmerged: boolean;
}

function assertInspectableIndex(output: string): void {
  if (output === '') return; // An unborn repository can have an empty index.
  if (!output.endsWith('\0')) throw new InspectionFailure('INVALID_GIT_OUTPUT');
  for (const entry of output.slice(0, -1).split('\0')) {
    const match = /^([A-Za-z]) ([0-7]{6}) (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]\t[\s\S]+$/.exec(
      entry,
    );
    const tag = match?.[1];
    const mode = match?.[2];
    if (tag === undefined || mode === undefined) throw new InspectionFailure('INVALID_GIT_OUTPUT');
    // -v exposes skip-worktree (S) and assume-unchanged (lowercase) entries.
    // Status may hide real edits for either; never clear these flags to inspect.
    if (tag === 'S' || tag !== tag.toUpperCase())
      throw new InspectionFailure('UNSUPPORTED_INDEX_FLAGS');
    if (tag !== 'H' && tag !== 'M') throw new InspectionFailure('INVALID_GIT_OUTPUT');
    if (mode === '160000') throw new InspectionFailure('SUBMODULES_UNASSESSED');
    if (!['100644', '100755', '120000'].includes(mode))
      throw new InspectionFailure('UNSUPPORTED_GIT_LAYOUT');
  }
}

function parseStatus(output: string): ParsedStatus {
  const invalid = () => new InspectionFailure('INVALID_GIT_OUTPUT');
  if (!output.endsWith('\0')) throw invalid();
  const headers = new Map<string, string>();
  let dirty = false;
  let unmerged = false;
  const hash = '(?:[0-9a-f]{40}|[0-9a-f]{64})';
  const ordinary = new RegExp(
    `^1 [MADRCUT.]{2} N\\.\\.\\. (?:[0-7]{6} ){3}${hash} ${hash} [\\s\\S]+$`,
  );
  const conflict = new RegExp(
    `^u [ADU]{2} N\\.\\.\\. (?:[0-7]{6} ){4}${hash} ${hash} ${hash} [\\s\\S]+$`,
  );
  for (const record of output.slice(0, -1).split('\0')) {
    if (record.startsWith('# ')) {
      const match = /^# (branch\.(?:oid|head|upstream|ab)) ([^\r\n\0]+)$/.exec(record);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        if (headers.has(match[1])) throw invalid();
        headers.set(match[1], match[2]);
      } else if (record.startsWith('# branch.')) throw invalid();
      continue; // Porcelain v2 explicitly permits additional future headers.
    }
    if (record.startsWith('? ') && record.length > 2) dirty = true;
    else if (ordinary.test(record)) dirty = true;
    else if (conflict.test(record)) {
      dirty = true;
      unmerged = true;
    } else throw invalid();
  }
  const oid = headers.get('branch.oid');
  const head = headers.get('branch.head');
  if (
    oid === undefined ||
    head === undefined ||
    (!new RegExp(`^${hash}$`).test(oid) && oid !== '(initial)')
  )
    throw invalid();
  const aheadBehind = headers.get('branch.ab');
  let unpushed: boolean | null = null;
  if (aheadBehind !== undefined) {
    const match = /^\+(0|[1-9][0-9]*) -(0|[1-9][0-9]*)$/.exec(aheadBehind);
    if (
      headers.get('branch.upstream') === undefined ||
      match === null ||
      !Number.isSafeInteger(Number(match[1])) ||
      !Number.isSafeInteger(Number(match[2]))
    )
      throw invalid();
    unpushed = Number(match[1]) > 0;
  }
  return {
    branch: head === '(detached)' ? null : head,
    headSha: oid === '(initial)' ? null : oid,
    dirty,
    unpushed,
    unmerged,
  };
}

/**
 * Observational only: never grants resume/cleanup permission. The coordinator
 * must quiesce task writers and revalidate before acting. Existing CommandRunner
 * audit/capture remains outside the workspace; this service writes no files/DB.
 */
export class WorkspaceRecovery {
  constructor(private readonly options: WorkspaceRecoveryOptions) {}

  async inspect(workspace: WorkspaceRecoveryTarget): Promise<WorkspaceRecoveryAssessment> {
    const result: WorkspaceRecoveryAssessment = {
      state: 'UNKNOWN',
      exists: null,
      branch: null,
      headSha: null,
      dirty: null,
      unpushed: null,
      indexLockPresent: null,
      expectedBranchMatches: null,
      reasons: [],
    };
    const reasons = new Set<WorkspaceRecoveryReason>();
    let unknown = false;
    let conflict = false;
    const note = (reason: WorkspaceRecoveryReason, isConflict = false): void => {
      reasons.add(reason);
      if (isConflict) conflict = true;
      else unknown = true;
    };

    try {
      const target = this.authorizedTarget(workspace);
      const repository = this.options.repositories.getById(target.repoId);
      if (repository?.githubRepositoryId !== target.repoId)
        throw new InspectionFailure('WORKSPACE_UNREGISTERED');
      const exists = this.workspaceExists(target);
      result.exists = exists;
      if (!exists) {
        reasons.add('WORKSPACE_MISSING');
      } else {
        const layout = gitLayout(target, repository.localBasePath);
        result.indexLockPresent = statIfPresent(join(layout.gitDir, 'index.lock')) !== undefined;
        if (result.indexLockPresent) note('INDEX_LOCK_PRESENT', true);
        // Only inspect the bound task's administrative directory. A marker is
        // evidence even with a clean index; never follow or alter its contents.
        if (
          operationMarkers.some((name) => statIfPresent(join(layout.gitDir, name)) !== undefined)
        ) {
          note('GIT_OPERATION_IN_PROGRESS', true);
        }
        assertUnsplitIndex(layout);
        const initialStamp = metadataStamp(layout);
        const prefix = [
          '--no-optional-locks',
          '--no-lazy-fetch',
          '--no-replace-objects',
          '--no-pager',
          `--git-dir=${layout.gitDir}`,
          `--work-tree=${target.linuxPath}`,
          '-c',
          'core.fsmonitor=false',
          '-c',
          'core.untrackedCache=false',
          '-c',
          'core.hooksPath=/dev/null',
        ];
        const revalidate = (): void => {
          this.authorizedTarget(target);
          this.guardPath(target, 'remove');
          const current = gitLayout(target, repository.localBasePath);
          assertUnsplitIndex(current);
          if (current.gitDir !== layout.gitDir || metadataStamp(current) !== initialStamp) {
            throw new InspectionFailure('GIT_STATE_CHANGED');
          }
        };
        const query = async (
          args: readonly string[],
          allowedExitCodes = [0],
        ): Promise<WorkspaceRecoveryGitResult> => {
          revalidate();
          let output: WorkspaceRecoveryGitResult;
          try {
            output = await this.options.runner.run({
              taskId: this.options.taskId,
              cwd: target.linuxPath,
              category: 'GIT',
              executable: 'git',
              args: [...prefix, ...args],
            });
          } catch (error) {
            if (
              error instanceof Error &&
              (error.name === 'ApprovalRequiredError' || error.name === 'PolicyDeniedError')
            ) {
              throw new InspectionFailure('POLICY_BLOCKED');
            }
            throw new InspectionFailure('GIT_FAILED');
          }
          if (!allowedExitCodes.includes(output.exitCode))
            throw new InspectionFailure('GIT_FAILED');
          // Git can return 0 after failing to read attributes or directories.
          // Unclassified diagnostics cannot establish a complete assessment.
          if (output.stderr !== '') throw new InspectionFailure('GIT_DIAGNOSTIC');
          return output;
        };
        // A status content hash can run clean/process filters. Query names only
        // (never config values/secrets) and decline those configurations first.
        const config = await query(
          [
            'config',
            '--name-only',
            '--get-regexp',
            '^(filter\\..*\\.(clean|process)|extensions\\.partialclone|core\\.sparsecheckout)$',
          ],
          [0, 1],
        );
        if (config.exitCode === 0) {
          if (config.stdout.trim() === '') throw new InspectionFailure('INVALID_GIT_OUTPUT');
          throw new InspectionFailure('UNSUPPORTED_GIT_CONFIG');
        }
        // For this exact git-config query, 1 + empty output means no matches.
        // Other nonzero results and diagnostics are never treated as success.
        if (config.stdout !== '' || config.stderr !== '') throw new InspectionFailure('GIT_FAILED');
        assertInspectableIndex(
          (await query(['ls-files', '-v', '--stage', '-z', '--abbrev=64'])).stdout,
        );
        const shallow = (await query(['rev-parse', '--is-shallow-repository'])).stdout;
        if (shallow === 'true\n') throw new InspectionFailure('SHALLOW_REPOSITORY');
        if (shallow !== 'false\n') throw new InspectionFailure('INVALID_GIT_OUTPUT');
        const status = parseStatus(
          (
            await query([
              'status',
              '--porcelain=v2',
              '--branch',
              '-z',
              '--untracked-files=all',
              '--ignore-submodules=all',
              '--no-renames',
              '--ahead-behind',
            ])
          ).stdout,
        );
        result.branch = status.branch;
        result.headSha = status.headSha;
        result.dirty = status.dirty;
        result.expectedBranchMatches = status.branch !== null && status.branch === target.branch;
        if (status.branch === null) note('DETACHED_HEAD', true);
        else if (!result.expectedBranchMatches) note('BRANCH_MISMATCH', true);
        if (status.headSha === null) note('UNBORN_HEAD');
        if (status.unmerged) note('UNMERGED_CHANGES', true);
        if (status.unpushed !== null) {
          const upstream = (await query(['rev-parse', '--symbolic-full-name', '@{upstream}']))
            .stdout;
          // A local branch can be configured as upstream and contain the same
          // unpushed commit. Only a cached remote-tracking ref is usable here.
          if (/^refs\/remotes\/[^\r\n\0 ]+\n$/.test(upstream)) result.unpushed = status.unpushed;
        }
        if (result.unpushed === null) note('UPSTREAM_UNAVAILABLE');
        if (statIfPresent(join(layout.gitDir, 'index.lock')) !== undefined) {
          result.indexLockPresent = true;
          note('INDEX_LOCK_PRESENT', true);
        }
        revalidate();
      }
    } catch (error) {
      if (error instanceof InspectionFailure) note(error.reason, error.conflict);
      else note('INSPECTION_FAILED'); // Sanitized: never copy stderr or filesystem errors.
    }
    result.reasons = [...reasons];
    result.state = conflict
      ? 'CONFLICT'
      : result.exists === false
        ? 'MISSING'
        : unknown
          ? 'UNKNOWN'
          : result.dirty === true
            ? 'DIRTY'
            : result.unpushed === true
              ? 'UNPUSHED'
              : result.exists === true &&
                  result.dirty === false &&
                  result.unpushed === false &&
                  result.expectedBranchMatches === true &&
                  result.headSha !== null &&
                  result.indexLockPresent === false
                ? 'CLEAN'
                : 'UNKNOWN';
    return result;
  }

  private authorizedTarget(input: WorkspaceRecoveryTarget): WorkspaceRecoveryTarget {
    if (input === null || typeof input !== 'object' || input.taskId !== this.options.taskId) {
      throw new InspectionFailure('WORKSPACE_BINDING_MISMATCH', true);
    }
    const stored = this.options.workspaces.getByTaskId(this.options.taskId);
    if (stored === undefined) throw new InspectionFailure('WORKSPACE_UNREGISTERED');
    if (
      stored.taskId !== input.taskId ||
      stored.repoId !== input.repoId ||
      stored.linuxPath !== input.linuxPath ||
      stored.branch !== input.branch
    ) {
      throw new InspectionFailure('WORKSPACE_BINDING_MISMATCH', true);
    }
    // Reject off-layout input before even lstat-ing the proposed workspace.
    if (
      !/^[A-Za-z0-9_-]+$/.test(stored.taskId) ||
      !Number.isSafeInteger(stored.repoId) ||
      stored.repoId <= 0 ||
      !isAbsolute(stored.linuxPath) ||
      resolve(stored.linuxPath) !==
        resolve(
          this.options.homeDir,
          '.gram-agent',
          'worktrees',
          String(stored.repoId),
          stored.taskId,
        )
    ) {
      throw new InspectionFailure('WORKSPACE_PATH_INVALID', true);
    }
    return {
      taskId: stored.taskId,
      repoId: stored.repoId,
      linuxPath: stored.linuxPath,
      branch: stored.branch,
    };
  }

  private guardPath(target: WorkspaceRecoveryTarget, mode: 'add' | 'remove'): void {
    try {
      // The shared guard itself performs no add/remove operation.
      assertTaskWorktreeTarget({
        homeDir: this.options.homeDir,
        taskId: this.options.taskId,
        repoId: target.repoId,
        target: target.linuxPath,
        mode,
      });
    } catch {
      throw new InspectionFailure('WORKSPACE_PATH_INVALID', true);
    }
  }

  private workspaceExists(target: WorkspaceRecoveryTarget): boolean {
    try {
      this.guardPath(target, 'remove');
      return true;
    } catch {
      // Both modes verify lexical AND canonical parent containment before
      // inspecting the target. Do not lstat through an unvalidated parent.
      this.guardPath(target, 'add');
      return false;
    }
  }
}
