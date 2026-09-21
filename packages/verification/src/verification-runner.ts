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
  review(
    context: VerificationTaskContext,
  ): Promise<VerificationGateResult & { changedPaths?: readonly string[] }>;
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

  async run(
    plan: PersistedVerificationPlan,
    context: VerificationTaskContext,
  ): Promise<VerificationResult> {
    if (context.taskId !== plan.taskId) {
      throw new Error('Verification plan task does not match task context');
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
          taskId: context.taskId,
          cwd: context.cwd,
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

      const gate = await this.runNonCommandCheck(check, context);
      await this.options.evidence.recordNonCommandResult({
        checkId: check.id,
        status: gate.status,
        evidenceRef: gate.evidenceRef,
        ...(gate.reason === undefined ? {} : { reason: gate.reason }),
      });
      results.push(resultFrom(check, gate.status, gate.reason));
    }

    return {
      passed: results
        .filter((check) => check.required)
        .every((check) => check.status === 'PASS'),
      checks: results,
    };
  }

  private async runNonCommandCheck(
    check: PersistedVerificationCheck,
    context: VerificationTaskContext,
  ): Promise<{
    status: Extract<
      VerificationCheckStatus,
      'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_REQUIRED'
    >;
    evidenceRef?: string;
    reason?: string;
  }> {
    let result: VerificationGateResult | undefined;

    if (check.name === 'secret-scan') {
      result = await this.options.secretScan.scan(context);
    } else if (check.name === 'diff-review') {
      result = await this.options.diffReview.review(context);
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
      ...(result.reason === undefined ? {} : { reason: result.reason }),
    };
  }
}
