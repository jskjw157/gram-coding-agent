import { isDeepStrictEqual } from 'node:util';
import type { BoundVerificationPlan, VerificationSnapshot } from '@gram/persistence';

interface BoundPublishingOptions {
  taskId: string;
  planId: number;
  headSha: string;
  paths: readonly string[];
  repository: { getBoundPlan(taskId: string, headSha: string, planId?: number): BoundVerificationPlan | undefined };
  snapshots: {
    capture(taskId: string): Promise<VerificationSnapshot>;
    assertCommitted(taskId: string, snapshot: VerificationSnapshot, paths: readonly string[], sha: string): Promise<void>;
  };
}

export class BoundPublishingVerification {
  constructor(private readonly options: BoundPublishingOptions) {}
  private requirePlan(taskId: string): BoundVerificationPlan {
    if (taskId !== this.options.taskId) throw new Error('Publication task mismatch');
    const plan = this.options.repository.getBoundPlan(taskId, this.options.headSha, this.options.planId);
    if (plan === undefined || plan.id !== this.options.planId || plan.taskId !== taskId || plan.headSha !== this.options.headSha) {
      throw new Error('Publication verification plan is absent or superseded');
    }
    if (!isDeepStrictEqual([...plan.approvedPaths].sort(), [...this.options.paths].sort())) {
      throw new Error('Publication paths do not match the verification plan');
    }
    return plan;
  }

  async assertPassed(taskId: string): Promise<void> {
    const plan = this.requirePlan(taskId);
    const current = await this.options.snapshots.capture(taskId);
    if (!isDeepStrictEqual(current, plan.snapshot)) throw new Error('Verification snapshot has changed');
  }

  async assertCommitted(taskId: string, sha: string): Promise<void> {
    const plan = this.requirePlan(taskId);
    await this.options.snapshots.assertCommitted(taskId, plan.snapshot, plan.approvedPaths, sha);
  }
}
