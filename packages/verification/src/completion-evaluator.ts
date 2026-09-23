export type CompletionCheckStatus =
  | 'PENDING'
  | 'PASS'
  | 'FAIL'
  | 'SKIPPED'
  | 'NOT_REQUIRED';

export interface VerificationCheckSnapshot {
  required: boolean;
  status: CompletionCheckStatus;
  hasEvidence: boolean;
}

export interface VerificationCheckReadPort {
  listForTask(taskId: string): readonly VerificationCheckSnapshot[];
}

export class CompletionEvaluator {
  constructor(private readonly checks: VerificationCheckReadPort) {}

  requiredChecksPassed(taskId: string): boolean {
    const checks = this.checks.listForTask(taskId);
    if (checks.length === 0) {
      return false;
    }
    const required = checks.filter((check) => check.required);
    if (required.length === 0) {
      return false;
    }
    return required.every((check) => check.status === 'PASS' && check.hasEvidence);
  }
}
