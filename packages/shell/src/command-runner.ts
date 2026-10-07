import { spawn as spawnProcess } from 'node:child_process';
import type { PolicyDecision, PublishMode } from '@gram/domain';
import {
  assertTaskWorktreeTarget,
  normalizeExecutableCommand,
  normalizeShellCommand,
  WORKTREE_PATH_REASON,
  type PolicyContext,
  PolicyEngine,
} from '@gram/policy';

export type CommandCategory =
  | 'DEVELOPMENT'
  | 'VERIFICATION'
  | 'GIT'
  | 'FILESYSTEM'
  | 'WINDOWS'
  | 'OTHER';

interface CommandRequestBase {
  taskId: string;
  cwd: string;
  category: CommandCategory;
  protectedBranches?: readonly string[];
  directMainGranted?: boolean;
  targetBranch?: string;
  publishMode?: PublishMode;
}

export type CommandRequest =
  | (CommandRequestBase & {
      shellText: string;
      executable?: never;
      args?: never;
    })
  | (CommandRequestBase & {
      executable: string;
      args?: readonly string[];
      shellText?: never;
    });

interface SpawnRequestBase {
  taskId: string;
  cwd: string;
  category: CommandCategory;
  env: Readonly<Record<string, string>>;
}

export type SpawnRequest =
  | (SpawnRequestBase & {
      shellText: string;
      executable?: never;
      args?: never;
    })
  | (SpawnRequestBase & {
      executable: string;
      args: readonly string[];
      shellText?: never;
    });

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ProcessSpawner {
  spawn(request: SpawnRequest): Promise<SpawnResult>;
}

export interface ApprovalConsumptionPort {
  consume(taskId: string, operationHash: string): Promise<boolean>;
}

export interface CommandRunStore {
  start(input: {
    taskId: string;
    category: string;
    cwd: string;
    executable?: string | null;
    args?: readonly string[] | null;
    shellText?: string | null;
    startedAt?: string;
  }): number;
  finish(
    id: number,
    input: {
      status: 'SUCCEEDED' | 'FAILED';
      exitCode: number | null;
      stdoutPath?: string | null;
      stderrPath?: string | null;
      truncated?: boolean;
      finishedAt?: string;
    },
  ): void;
}

export interface CommandOutputCapturePort {
  redactText(text: string): string;
  capture(input: {
    taskId: string;
    commandRunId: number;
    stdout: string;
    stderr: string;
  }): Promise<{
    stdout: string;
    stderr: string;
    stdoutPath: string;
    stderrPath: string;
  }>;
}

export interface CommandResult extends SpawnResult {
  commandRunId: number;
  stdoutPath: string;
  stderrPath: string;
}

export class PolicyDeniedError extends Error {
  constructor(readonly decision: PolicyDecision) {
    super(decision.reason);
    this.name = 'PolicyDeniedError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(readonly decision: PolicyDecision) {
    super(decision.reason);
    this.name = 'ApprovalRequiredError';
  }
}

export interface CommandRunnerOptions {
  policy: PolicyEngine;
  approvals: ApprovalConsumptionPort;
  spawner: ProcessSpawner;
  commandRuns: CommandRunStore;
  outputCapture: CommandOutputCapturePort;
  environment?: NodeJS.ProcessEnv;
  // Agent home used by the worktree path preflight. Optional for existing
  // callers, but a worktree add/remove that needs the guard fails closed
  // when it is absent.
  homeDir?: string;
}

const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'NODE_ENV',
] as const;

export function buildSafeCommandEnvironment(
  source: NodeJS.ProcessEnv,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function contextFor(request: CommandRequest): PolicyContext {
  return {
    taskId: request.taskId,
    ...(request.protectedBranches === undefined
      ? {}
      : { protectedBranches: request.protectedBranches }),
    ...(request.directMainGranted === undefined
      ? {}
      : { directMainGranted: request.directMainGranted }),
    ...(request.targetBranch === undefined
      ? {}
      : { targetBranch: request.targetBranch }),
    ...(request.publishMode === undefined
      ? {}
      : { publishMode: request.publishMode }),
  };
}

function operationsFor(request: CommandRequest) {
  if ('shellText' in request) {
    return normalizeShellCommand(request.shellText, request.cwd);
  }
  return [
    normalizeExecutableCommand(
      request.executable,
      request.args ?? [],
      request.cwd,
    ),
  ];
}

interface WorktreeTarget {
  mode: 'add' | 'remove';
  target: string;
}

// Mirrors the ALLOW shapes in risk-classifier classifyGit: `worktree add
// -b <branch> <path> <base>` (6 args) and `worktree remove --force <path>`
// (4 args). Anything else (including `worktree prune`, which has no target)
// returns null and needs no path check. Kept in sync with
// POL-GIT-WORKTREE-TASK by construction: only shapes the classifier allows
// reach the preflight as ALLOW.
function worktreeTargetFor(args: readonly string[]): WorktreeTarget | null {
  if (
    args.length === 6 &&
    args[0] === 'worktree' &&
    args[1] === 'add' &&
    args[2] === '-b' &&
    args[3] !== undefined &&
    args[3].length > 0 &&
    args[4] !== undefined &&
    args[4].length > 0 &&
    args[5] !== undefined &&
    args[5].length > 0
  ) {
    return { mode: 'add', target: args[4] };
  }
  if (
    args.length === 4 &&
    args[0] === 'worktree' &&
    args[1] === 'remove' &&
    args[2] === '--force' &&
    args[3] !== undefined &&
    args[3].length > 0
  ) {
    return { mode: 'remove', target: args[3] };
  }
  return null;
}

// The layout segment directly above the task directory is the repository id:
// <home>/.gram-agent/worktrees/<repoId>/<taskId>. Parsing it from the target
// keeps a single shared guard: a non-numeric segment fails the guard's
// identity check, and a task segment that differs from the requesting task
// fails its lexical check. Both fail closed with the shared reason.
function repoIdForWorktreeTarget(target: string): number {
  const segments = target.split('/').filter((segment) => segment.length > 0);
  const repoSegment = segments.length >= 2 ? segments[segments.length - 2] : undefined;
  return repoSegment === undefined ? Number.NaN : Number(repoSegment);
}

function worktreePathDenied(decision: PolicyDecision): PolicyDeniedError {
  return new PolicyDeniedError({
    kind: 'DENY',
    ruleId: 'POL-GIT-WORKTREE-PATH',
    reason: WORKTREE_PATH_REASON,
    operationHash: decision.operationHash,
  });
}

export class NodeProcessSpawner implements ProcessSpawner {
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    return new Promise((resolve, reject) => {
      const child =
        'shellText' in request
          ? spawnProcess('/bin/bash', ['-lc', request.shellText], {
              cwd: request.cwd,
              env: { ...request.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            })
          : spawnProcess(request.executable, [...request.args], {
              cwd: request.cwd,
              env: { ...request.env },
              stdio: ['ignore', 'pipe', 'pipe'],
            });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === null) {
          reject(new Error('Process terminated without an exit code'));
          return;
        }
        resolve({ exitCode: code, stdout, stderr });
      });
    });
  }
}

export class CommandRunner {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(private readonly options: CommandRunnerOptions) {
    this.environment = options.environment ?? process.env;
  }

  async run(request: CommandRequest): Promise<CommandResult> {
    const operations = operationsFor(request);
    if (operations.length === 0) {
      throw new Error('Command did not contain an executable operation');
    }

    const context = contextFor(request);
    const decisions = operations.map((operation) =>
      this.options.policy.evaluate(operation, context),
    );

    const denied = decisions.find((decision) => decision.kind === 'DENY');
    if (denied !== undefined) throw new PolicyDeniedError(denied);

    for (const decision of decisions) {
      if (decision.kind !== 'NEEDS_APPROVAL') continue;
      const consumed = await this.options.approvals.consume(
        request.taskId,
        decision.operationHash,
      );
      if (!consumed) throw new ApprovalRequiredError(decision);
    }

    // Worktree path preflight: now that `git worktree add` and
    // `git worktree remove --force` classify ALLOW, a direct CommandRunner
    // call must not bypass the workspace-level guard. This runs after policy
    // evaluation and approval consumption (DENY and NEEDS_APPROVAL behavior
    // is unchanged) but BEFORE commandRuns.start and spawner.spawn, so a
    // denied path leaves no run record and no child process. `worktree
    // prune` has no target and needs no check. PolicyContext and
    // operationHash() are untouched, so outstanding approvals stay valid.
    for (let index = 0; index < decisions.length; index += 1) {
      const decision = decisions[index];
      const operation = operations[index];
      if (decision === undefined || operation === undefined) {
        throw new PolicyDeniedError({
          kind: 'DENY',
          ruleId: 'POL-GIT-WORKTREE-PATH',
          reason: WORKTREE_PATH_REASON,
          operationHash: decision?.operationHash ?? 'unknown',
        });
      }
      if (decision.kind !== 'ALLOW') continue;
      if (operation.executable !== 'git') continue;
      const found = worktreeTargetFor(operation.args);
      if (found === null) continue;
      const homeDir = this.options.homeDir;
      // Fail closed when the guard has no home directory to check against.
      if (homeDir === undefined || homeDir.length === 0) throw worktreePathDenied(decision);
      try {
        assertTaskWorktreeTarget({
          homeDir,
          taskId: request.taskId,
          repoId: repoIdForWorktreeTarget(found.target),
          target: found.target,
          mode: found.mode,
        });
      } catch {
        throw worktreePathDenied(decision);
      }
    }

    const commandRunId = this.options.commandRuns.start({
      taskId: request.taskId,
      category: request.category,
      cwd: request.cwd,
      ...('shellText' in request
        ? {
            shellText: this.options.outputCapture.redactText(request.shellText),
          }
        : {
            executable: this.options.outputCapture.redactText(request.executable),
            args: (request.args ?? []).map((argument) =>
              this.options.outputCapture.redactText(argument),
            ),
          }),
    });

    const env = buildSafeCommandEnvironment(this.environment);

    try {
      const raw = await this.options.spawner.spawn(
        'shellText' in request
          ? {
              taskId: request.taskId,
              cwd: request.cwd,
              category: request.category,
              shellText: request.shellText,
              env,
            }
          : {
              taskId: request.taskId,
              cwd: request.cwd,
              category: request.category,
              executable: request.executable,
              args: request.args ?? [],
              env,
            },
      );
      const captured = await this.options.outputCapture.capture({
        taskId: request.taskId,
        commandRunId,
        stdout: raw.stdout,
        stderr: raw.stderr,
      });

      this.options.commandRuns.finish(commandRunId, {
        status: raw.exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
        exitCode: raw.exitCode,
        stdoutPath: captured.stdoutPath,
        stderrPath: captured.stderrPath,
      });

      return {
        commandRunId,
        exitCode: raw.exitCode,
        stdout: captured.stdout,
        stderr: captured.stderr,
        stdoutPath: captured.stdoutPath,
        stderrPath: captured.stderrPath,
      };
    } catch (error) {
      this.options.commandRuns.finish(commandRunId, {
        status: 'FAILED',
        exitCode: null,
      });
      throw error;
    }
  }
}
