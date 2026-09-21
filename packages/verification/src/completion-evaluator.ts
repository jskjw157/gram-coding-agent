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
    return this.checks
      .listForTask(taskId)
      .filter((check) => check.required)
      .every((check) => check.status === 'PASS' && check.hasEvidence);
  }
}
