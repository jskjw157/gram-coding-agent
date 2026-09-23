import type { TaskId } from '@gram/domain';
import type {
  AnalyzePort,
  CiObservePort,
  CompletePort,
  InstructionsPort,
  ModifyPort,
  PrEnsurePort,
  PublishPort,
  RepoFetchPort,
  RepoResolvePort,
  TaskAuditPort,
  VerifyPort,
  WorkspaceCreatePort,
} from './task-runner-ports.js';

export type RepairCycleEvent =
  | 'ci.failed'
  | 'lock.acquire'
  | 'workspace.reuse'
  | 'repair'
  | 'verify'
  | 'push'
  | 'remote.confirm'
  | 'lock.release'
  | 'ci.observe';

export type RepairCycleCiOutcome = 'SUCCESS' | 'FAILURE' | 'PENDING';

export interface RepairCycleLease {
  release(): Promise<void>;
}

export interface RepairCycleLockPort {
  acquire(repoId: number, taskId: TaskId): Promise<RepairCycleLease>;
}

export interface RepairCycleWorkspace {
  linuxPath: string;
  branch: string;
}

export interface RepairCycleWorkspacePort {
  reuse(taskId: TaskId): Promise<RepairCycleWorkspace>;
}

export interface RepairCycleMutationPort {
  repair(input: { taskId: TaskId; workspace: RepairCycleWorkspace }): Promise<void>;
}

export interface RepairCycleVerifyPort {
  verify(taskId: TaskId): Promise<void>;
}

export interface RepairCycleGitPort {
  push(worktree: string, branch: string): Promise<string>;
  confirmRemoteSha(remote: string, branch: string, expectedSha: string): Promise<boolean>;
}

export interface RepairCycleCiPort {
  observe(taskId: TaskId): Promise<RepairCycleCiOutcome>;
}

export interface TaskRunnerOptions {
  audit: TaskAuditPort;
  locks: RepairCycleLockPort;
  workspaces: RepairCycleWorkspacePort;
  mutations: RepairCycleMutationPort;
  verification: RepairCycleVerifyPort;
  git: RepairCycleGitPort;
  ci: RepairCycleCiPort;
  repoResolve?: RepoResolvePort;
  repoFetch?: RepoFetchPort;
  workspaceCreate?: WorkspaceCreatePort;
  instructions?: InstructionsPort;
  analyze?: AnalyzePort;
  modify?: ModifyPort;
  verify?: VerifyPort;
  publish?: PublishPort;
  prEnsure?: PrEnsurePort;
  ciObserve?: CiObservePort;
  complete?: CompletePort;
}

export interface RepairCycleInput {
  taskId: TaskId;
  repoId: number;
  branch: string;
  remote: string;
  ciOutcome: RepairCycleCiOutcome;
}

export interface RepairCycleResult {
  taskId: TaskId;
  repoId: number;
  sha: string;
  branch: string;
  remote: string;
  ciOutcome: RepairCycleCiOutcome;
}

export class NotRepairableCiOutcomeError extends Error {
  constructor(outcome: RepairCycleCiOutcome) {
    super(`CI outcome is not repairable: ${outcome}`);
    this.name = 'NotRepairableCiOutcomeError';
  }
}

export class RemoteConfirmFailedError extends Error {
  constructor(remote: string, branch: string, expectedSha: string) {
    super(`Remote ${remote} did not confirm ${expectedSha} at refs/heads/${branch}`);
    this.name = 'RemoteConfirmFailedError';
  }
}

export class VerificationFailedError extends Error {
  constructor(taskId: TaskId, output: string) {
    super(`Verification failed for task ${taskId}: ${output}`);
    this.name = 'VerificationFailedError';
  }
}

function requireRunPort<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`TaskRunner.run missing port: ${name}`);
  }
  return value;
}

export class TaskRunner {
  constructor(private readonly options: TaskRunnerOptions) {}

  async run(taskId: TaskId): Promise<void> {
    const repoResolve = requireRunPort(this.options.repoResolve, 'repoResolve');
    const repoFetch = requireRunPort(this.options.repoFetch, 'repoFetch');
    const workspaceCreate = requireRunPort(this.options.workspaceCreate, 'workspaceCreate');
    const instructionsPort = requireRunPort(this.options.instructions, 'instructions');
    const analyzePort = requireRunPort(this.options.analyze, 'analyze');
    const modifyPort = requireRunPort(this.options.modify, 'modify');
    const verifyPort = requireRunPort(this.options.verify, 'verify');
    const publishPort = requireRunPort(this.options.publish, 'publish');
    const prEnsurePort = requireRunPort(this.options.prEnsure, 'prEnsure');
    const ciObservePort = requireRunPort(this.options.ciObserve, 'ciObserve');
    const completePort = requireRunPort(this.options.complete, 'complete');

    const resolved = await repoResolve.resolve(taskId);
    const lease = await this.options.locks.acquire(resolved.repoId, taskId);
    await repoFetch.fetch(resolved);
    const workspace = await workspaceCreate.create(taskId);
    const instructions = await instructionsPort.load(workspace);
    const analysis = await analyzePort.analyze({
      task: resolved,
      workspace,
      instructions,
    });
    await modifyPort.modify({ task: resolved, workspace, analysis });
    const verification = await verifyPort.verify(taskId);
    if (!verification.passed) {
      throw new VerificationFailedError(taskId, verification.output);
    }
    const published = await publishPort.publish(resolved, workspace, verification, lease);
    await prEnsurePort.ensure(resolved, published);
    const outcome = await ciObservePort.observe(taskId);
    if (outcome === 'SUCCESS') {
      await completePort.complete(taskId);
    }
  }

  async runRepairCycle(
    input: RepairCycleInput,
    onEvent?: (event: RepairCycleEvent) => void,
  ): Promise<RepairCycleResult> {
    if (input.ciOutcome !== 'FAILURE') {
      throw new NotRepairableCiOutcomeError(input.ciOutcome);
    }

    const emit = (event: RepairCycleEvent): void => {
      onEvent?.(event);
    };

    this.options.audit.append({
      taskId: input.taskId,
      eventType: 'REPAIR_CYCLE_STARTED',
      payload: { repoId: input.repoId, branch: input.branch },
    });
    emit('ci.failed');

    const lease = await this.options.locks.acquire(input.repoId, input.taskId);
    emit('lock.acquire');

    const workspace = await this.options.workspaces.reuse(input.taskId);
    emit('workspace.reuse');

    await this.options.mutations.repair({ taskId: input.taskId, workspace });
    emit('repair');

    await this.options.verification.verify(input.taskId);
    emit('verify');

    const sha = await this.options.git.push(workspace.linuxPath, input.branch);
    emit('push');

    const confirmed = await this.options.git.confirmRemoteSha(input.remote, input.branch, sha);
    emit('remote.confirm');
    if (!confirmed) {
      throw new RemoteConfirmFailedError(input.remote, input.branch, sha);
    }

    await lease.release();
    emit('lock.release');

    const ciOutcome = await this.options.ci.observe(input.taskId);
    emit('ci.observe');

    this.options.audit.append({
      taskId: input.taskId,
      eventType: 'REPAIR_CYCLE_COMPLETED',
      payload: { repoId: input.repoId, branch: input.branch, sha, ciOutcome },
    });

    return {
      taskId: input.taskId,
      repoId: input.repoId,
      sha,
      branch: input.branch,
      remote: input.remote,
      ciOutcome,
    };
  }
}
