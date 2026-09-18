import type { CommandRequest } from '@gram/shell';

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCommandRunnerPort {
  run(request: CommandRequest): Promise<GitCommandResult>;
}

export interface GitTaskContext {
  taskId: string;
  protectedBranches?: readonly string[];
  directMainGranted?: boolean;
}

export function gitCommandRequest(
  context: GitTaskContext,
  cwd: string,
  args: readonly string[],
): CommandRequest {
  return {
    taskId: context.taskId,
    cwd,
    category: 'GIT',
    executable: 'git',
    args,
    ...(context.protectedBranches === undefined
      ? {}
      : { protectedBranches: context.protectedBranches }),
    ...(context.directMainGranted === undefined
      ? {}
      : { directMainGranted: context.directMainGranted }),
  };
}

export async function runGit(
  runner: GitCommandRunnerPort,
  context: GitTaskContext,
  cwd: string,
  args: readonly string[],
): Promise<GitCommandResult> {
  const result = await runner.run(gitCommandRequest(context, cwd, args));
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
    throw new Error(`git ${args[0] ?? 'command'} failed: ${detail}`);
  }
  return result;
}
