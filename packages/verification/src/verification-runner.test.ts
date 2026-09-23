import { describe, expect, it, vi } from 'vitest';
import {
  VerificationRunner,
  type PersistedVerificationPlan,
} from './verification-runner.js';

describe('VerificationRunner', () => {
  it('runs command checks and required publish gates with persisted evidence', async () => {
    const recordCommandResult = vi.fn();
    const recordNonCommandResult = vi.fn();
    const run = vi.fn(async () => ({
      commandRunId: 77,
      exitCode: 0,
      stdout: 'ok',
      stderr: '',
      stdoutPath: '/logs/77.out',
      stderrPath: '/logs/77.err',
    }));
    const secretScan = vi.fn(async () => ({
      passed: true,
      evidenceRef: 'secret-scan:clean',
    }));
    const diffReview = vi.fn(async () => ({
      passed: true,
      evidenceRef: 'diff-review:src/app.ts',
      changedPaths: ['src/app.ts'],
    }));

    const runner = new VerificationRunner({
      commands: { run },
      evidence: { recordCommandResult, recordNonCommandResult },
      secretScan: { scan: secretScan },
      diffReview: { review: diffReview },
    });

    const plan: PersistedVerificationPlan = {
      id: 1,
      taskId: '018f0000-0000-7000-8000-000000000001',
      changeClass: 'FRONTEND_LOGIC',
      checks: [
        {
          id: 11,
          name: 'lint',
          kind: 'COMMAND',
          required: true,
          status: 'PENDING',
          command: 'pnpm lint',
        },
        {
          id: 12,
          name: 'secret-scan',
          kind: 'NON_COMMAND',
          required: true,
          status: 'PENDING',
        },
        {
          id: 13,
          name: 'diff-review',
          kind: 'NON_COMMAND',
          required: true,
          status: 'PENDING',
        },
      ],
    };

    const result = await runner.run(plan, {
      taskId: plan.taskId,
      cwd: '/worktree',
    });

    expect(run).toHaveBeenCalledWith({
      taskId: plan.taskId,
      cwd: '/worktree',
      category: 'VERIFICATION',
      shellText: 'pnpm lint',
    });
    expect(recordCommandResult).toHaveBeenCalledWith({
      checkId: 11,
      status: 'PASS',
      commandRunId: 77,
    });
    expect(recordNonCommandResult).toHaveBeenCalledWith({
      checkId: 12,
      status: 'PASS',
      evidenceRef: 'secret-scan:clean',
    });
    expect(recordNonCommandResult).toHaveBeenCalledWith({
      checkId: 13,
      status: 'PASS',
      evidenceRef: 'diff-review:src/app.ts',
    });
    expect(result.passed).toBe(true);
    expect(result.checks.map((check) => check.status)).toEqual([
      'PASS',
      'PASS',
      'PASS',
    ]);
  });

  it('fails verification when a required command exits non-zero', async () => {
    const recordCommandResult = vi.fn();
    const runner = new VerificationRunner({
      commands: {
        run: vi.fn(async () => ({
          commandRunId: 88,
          exitCode: 1,
          stdout: '',
          stderr: 'failed',
          stdoutPath: '/logs/88.out',
          stderrPath: '/logs/88.err',
        })),
      },
      evidence: {
        recordCommandResult,
        recordNonCommandResult: vi.fn(),
      },
      secretScan: {
        scan: vi.fn(async () => ({ passed: true, evidenceRef: 'secret-scan:clean' })),
      },
      diffReview: {
        review: vi.fn(async () => ({
          passed: true,
          evidenceRef: 'diff-review:clean',
          changedPaths: [],
        })),
      },
    });

    const plan: PersistedVerificationPlan = {
      id: 2,
      taskId: '018f0000-0000-7000-8000-000000000002',
      changeClass: 'FRONTEND_LOGIC',
      checks: [
        {
          id: 21,
          name: 'test',
          kind: 'COMMAND',
          required: true,
          status: 'PENDING',
          command: 'pnpm test',
        },
      ],
    };

    const result = await runner.run(plan, {
      taskId: plan.taskId,
      cwd: '/worktree',
    });

    expect(recordCommandResult).toHaveBeenCalledWith({
      checkId: 21,
      status: 'FAIL',
      commandRunId: 88,
    });
    expect(result.passed).toBe(false);
  });
});
