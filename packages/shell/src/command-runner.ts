import type { PolicyDecision } from '@gram/domain';
import {
  normalizeShellCommand,
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

export interface CommandRequest {
  taskId: string;
  cwd: string;
  category: CommandCategory;
  shellText: string;
  protectedBranches?: readonly string[];
  directMainGranted?: boolean;
}

export interface SpawnRequest {
  taskId: string;
  cwd: string;
  category: CommandCategory;
  shellText: string;
}

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
  };
}

export class CommandRunner {
  constructor(private readonly options: CommandRunnerOptions) {}

  async run(request: CommandRequest): Promise<SpawnResult> {
    const operations = normalizeShellCommand(request.shellText, request.cwd);
    if (operations.length === 0) throw new Error('Command did not contain an executable operation');

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

    return this.options.spawner.spawn({
      taskId: request.taskId,
      cwd: request.cwd,
      category: request.category,
      shellText: request.shellText,
    });
  }
}
