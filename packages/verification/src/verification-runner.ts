import { isDeepStrictEqual } from 'node:util';
import type { VerificationSnapshot } from '@gram/persistence';
import type { VerificationCheckStatus } from './verification-planner.js';
import type {
  PersistedVerificationCheck,
  PersistedVerificationPlan as EvidencePersistedVerificationPlan,
} from './evidence-collector.js';

export type PersistedVerificationPlan = EvidencePersistedVerificationPlan;

export interface VerificationTaskContext {
  taskId: string;
  cwd: string;
}

export interface VerificationCommandResult {
  commandRunId: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutPath: string;
  stderrPath: string;
}

export interface VerificationCommandPort {
  run(input: {
    taskId: string;
    cwd: string;
    category: 'VERIFICATION';
    shellText: string;
  }): Promise<VerificationCommandResult>;
}

export interface VerificationEvidencePort {
  sealSnapshot?(planId: number, snapshot: VerificationSnapshot): void | Promise<void>;
  recordCommandResult(input: {
    checkId: number;
    status: 'PASS' | 'FAIL';
    commandRunId: number;
    reason?: string;
  }): void | Promise<void>;
  recordNonCommandResult(input: {
    checkId: number;
    status: 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_REQUIRED';
    evidenceRef?: string;
    approvedPaths?: readonly string[];
    reason?: string;
  }): void | Promise<void>;
}

export interface VerificationGateResult {
  passed: boolean;
  evidenceRef: string;
  reason?: string;
}

export interface SecretScanPort {
  scan(context: VerificationTaskContext): Promise<VerificationGateResult>;
}

export interface DiffReviewPort {
  review(context: VerificationTaskContext): Promise<VerificationGateResult & { changedPaths?: readonly string[] }>;
}

export interface BrowserVerificationPort {
  verify(context: VerificationTaskContext): Promise<VerificationGateResult>;
}

export interface VerificationRunnerOptions {
  commands: VerificationCommandPort;
  evidence: VerificationEvidencePort;
  secretScan: SecretScanPort;
  diffReview: DiffReviewPort;
  browser?: BrowserVerificationPort;
  snapshots?: { capture(taskId: string, expectedCwd?: string): Promise<VerificationSnapshot> };
}

export interface VerificationCheckResult {
  id: number;
  name: string;
  required: boolean;
  status: VerificationCheckStatus;
  reason?: string;
}

export interface VerificationResult {
  passed: boolean;
  checks: VerificationCheckResult[];
}

function resultFrom(
  check: PersistedVerificationCheck,
  status: VerificationCheckStatus,
  reason?: string,
): VerificationCheckResult {
  return {
    id: check.id,
    name: check.name,
    required: check.required,
    status,
    ...(reason === undefined ? {} : { reason }),
  };
}

export class VerificationRunner {
  constructor(private readonly options: VerificationRunnerOptions) {}

  async run(plan: PersistedVerificationPlan, context: VerificationTaskContext): Promise<VerificationResult> {
    const boundContext = Object.freeze({ taskId: context.taskId, cwd: context.cwd });
    if (boundContext.taskId !== plan.taskId) {
      throw new Error('Verification plan task does not match task context');
    }

    let before: VerificationSnapshot | undefined;
    if (this.options.snapshots !== undefined) {
      if (this.options.evidence.sealSnapshot === undefined) {
        throw new Error('Snapshot verification requires evidence sealing');
      }
      if (plan.checks.some((check) => check.required && check.status !== 'PENDING')) {
        throw new Error('Snapshot verification requires fresh PENDING required checks');
      }
      before = structuredClone(await this.options.snapshots.capture(boundContext.taskId, boundContext.cwd));
      if (before.taskId !== plan.taskId || before.headSha !== plan.headSha) {
        throw new Error('Verification snapshot task and HEAD do not match the plan');
      }
    }

    const results: VerificationCheckResult[] = [];

    for (const check of plan.checks) {
      if (check.status !== 'PENDING') {
        results.push(resultFrom(check, check.status, check.reason));
        continue;
      }

      if (check.kind === 'COMMAND') {
        if (check.command === undefined || check.command.trim().length === 0) {
          throw new Error(`Verification command is missing for check ${check.name}`);
        }

        const command = await this.options.commands.run({
          taskId: boundContext.taskId,
          cwd: boundContext.cwd,
          category: 'VERIFICATION',
          shellText: check.command,
        });
        const status = command.exitCode === 0 ? 'PASS' : 'FAIL';
        await this.options.evidence.recordCommandResult({
          checkId: check.id,
          status,
          commandRunId: command.commandRunId,
        });
        results.push(resultFrom(check, status));
        continue;
      }

      const gate = await this.runNonCommandCheck(check, boundContext);
      await this.options.evidence.recordNonCommandResult({
        checkId: check.id,
        status: gate.status,
        ...(gate.evidenceRef === undefined ? {} : { evidenceRef: gate.evidenceRef }),
        ...(gate.approvedPaths === undefined ? {} : { approvedPaths: gate.approvedPaths }),
        ...(gate.reason === undefined ? {} : { reason: gate.reason }),
      });
      results.push(resultFrom(check, gate.status, gate.reason));
    }

    const required = results.filter((check) => check.required);
    const passed = required.length > 0 && required.every((check) => check.status === 'PASS');
    if (passed && before !== undefined && this.options.snapshots !== undefined) {
      const after = await this.options.snapshots.capture(boundContext.taskId, boundContext.cwd);
      if (!isDeepStrictEqual(before, after)) {
        throw new Error('Verification snapshot changed while checks were running');
      }
      await this.options.evidence.sealSnapshot?.(plan.id, before);
    }
    return { passed, checks: results };
  }

  private async runNonCommandCheck(
    check: PersistedVerificationCheck,
    context: VerificationTaskContext,
  ): Promise<{
    status: Extract<VerificationCheckStatus, 'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_REQUIRED'>;
    evidenceRef?: string;
    approvedPaths?: readonly string[];
    reason?: string;
  }> {
    let result: VerificationGateResult | undefined;
    let approvedPaths: readonly string[] | undefined;

    if (check.name === 'secret-scan') {
      result = await this.options.secretScan.scan(context);
    } else if (check.name === 'diff-review') {
      const review = await this.options.diffReview.review(context);
      result = review;
      if (review.passed && review.changedPaths !== undefined) {
        approvedPaths = review.changedPaths;
      }
    } else if (check.name === 'browser') {
      if (this.options.browser === undefined) {
        return {
          status: 'SKIPPED',
          evidenceRef: 'browser-verifier:unavailable',
          reason: 'Browser verification capability is declared but no verifier is available',
        };
      }
      result = await this.options.browser.verify(context);
    } else {
      return {
        status: 'SKIPPED',
        evidenceRef: `verifier:missing:${check.name}`,
        reason: `No verifier is registered for ${check.name}`,
      };
    }

    return {
      status: result.passed ? 'PASS' : 'FAIL',
      evidenceRef: result.evidenceRef,
      ...(approvedPaths === undefined ? {} : { approvedPaths }),
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }
}
