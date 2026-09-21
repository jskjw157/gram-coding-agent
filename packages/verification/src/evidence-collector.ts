import type { TaskId } from '@gram/domain';
import {
  VerificationRepository,
  type StoredVerificationCheckStatus,
} from '@gram/persistence';
import type {
  PlannedVerificationCheck,
  VerificationPlan,
} from './verification-planner.js';

export interface PersistedVerificationCheck extends PlannedVerificationCheck {
  id: number;
}

export interface PersistedVerificationPlan
  extends Omit<VerificationPlan, 'checks'> {
  id: number;
  taskId: TaskId;
  checks: PersistedVerificationCheck[];
}

export interface PersistVerificationPlanInput {
  taskId: TaskId;
  headSha?: string | null;
  risk?: string | null;
  plan: VerificationPlan;
}

export class EvidenceCollector {
  constructor(private readonly repository: VerificationRepository) {}

  persistPlan(input: PersistVerificationPlanInput): PersistedVerificationPlan {
    const planId = this.repository.createPlan({
      taskId: input.taskId,
      headSha: input.headSha,
      changeClass: input.plan.changeClass,
      risk: input.risk,
      plan: input.plan,
    });

    const checks = input.plan.checks.map((check) => {
      const id = this.repository.createCheck({
        planId,
        taskId: input.taskId,
        name: check.name,
        required: check.required,
        status: check.status,
        reason: check.reason,
      });
      return { ...check, id };
    });

    return {
      id: planId,
      taskId: input.taskId,
      changeClass: input.plan.changeClass,
      checks,
    };
  }

  recordCommandResult(input: {
    checkId: number;
    status: Extract<StoredVerificationCheckStatus, 'PASS' | 'FAIL'>;
    commandRunId: number;
    reason?: string;
  }): void {
    this.repository.finishCheck(input.checkId, {
      status: input.status,
      commandRunId: input.commandRunId,
      reason: input.reason,
    });
  }

  recordNonCommandResult(input: {
    checkId: number;
    status: Extract<
      StoredVerificationCheckStatus,
      'PASS' | 'FAIL' | 'SKIPPED' | 'NOT_REQUIRED'
    >;
    evidenceRef?: string;
    reason?: string;
  }): void {
    this.repository.finishCheck(input.checkId, {
      status: input.status,
      evidenceRef: input.evidenceRef,
      reason: input.reason,
    });
  }
}
