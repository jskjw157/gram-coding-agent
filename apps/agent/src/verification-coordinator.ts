import { isDeepStrictEqual } from 'node:util';
import type {
  RepositoryRepository,
  TaskRepository,
  VerificationRepository,
  VerificationSnapshot,
} from '@gram/persistence';
import {
  CompletionEvaluator,
  EvidenceCollector,
  VerificationPlanner,
  VerificationRunner,
  type VerificationCommandPort,
  type PersistedVerificationPlan,
} from '@gram/verification';
import { PersistentVerificationCompletion } from './persistence-adapters.js';
import type { ExternalVerificationReview } from './external-verification-review.js';
export interface VerificationCoordinatorOptions {
  tasks: TaskRepository;
  repositories: RepositoryRepository;
  verification: VerificationRepository;
  snapshots: { capture(taskId: string, cwd?: string): Promise<VerificationSnapshot> };
  commands: VerificationCommandPort;
  reviews: ExternalVerificationReview;
}
/** Creates fresh production proof; historical task-only repair remains deliberately unsupported. */
export class VerificationCoordinator extends PersistentVerificationCompletion {
  private readonly running = new Set<string>();
  constructor(private readonly options: VerificationCoordinatorOptions) {
    super(new CompletionEvaluator(options.verification), options.verification);
  }
  async execute(taskId: string, headSha: string): Promise<void> {
    if (this.running.has(taskId)) throw new Error('Verification execution is already running');
    this.running.add(taskId);
    try {
      const workspace = this.options.reviews.assertActive(taskId),
        task = this.options.tasks.get(taskId);
      const repo = task?.repoId == null ? undefined : this.options.repositories.getById(task.repoId);
      if (repo === undefined) throw new Error('Verification requires a registered repository profile');
      const expected = structuredClone(await this.options.snapshots.capture(taskId, workspace.linuxPath));
      if (expected.taskId !== taskId || expected.headSha !== headSha)
        throw new Error('Verification initial HEAD does not match');
      this.options.reviews.assertActive(taskId);
      const planned = new VerificationPlanner().planProduction(
        { paths: expected.entries.map((e) => e.path) },
        { commands: repo.commands },
      );
      const collector = new EvidenceCollector(this.options.verification);
      const productionPlan = { ...planned, externalReviews: true };
      const plan = collector.persistPlan({ taskId, headSha, plan: productionPlan });
      let commandFailed = false;
      const assertCurrent = () => {
        const active = this.options.reviews.assertActive(taskId);
        if (
          active.id !== workspace.id ||
          active.linuxPath !== workspace.linuxPath ||
          active.branch !== workspace.branch ||
          active.leaseToken !== workspace.leaseToken ||
          !this.options.verification.isCurrentPlan(taskId, plan.id, headSha)
        )
          throw new Error('Verification task/lease/workspace/plan binding changed');
      };
      const boundSnapshots = {
        capture: async (id: string, cwd?: string) => {
          assertCurrent();
          if (id !== taskId || cwd !== workspace.linuxPath) throw new Error('Verification snapshot context mismatch');
          const snapshot = await this.options.snapshots.capture(taskId, workspace.linuxPath);
          assertCurrent();
          if (!isDeepStrictEqual(snapshot, expected)) throw new Error('Verification snapshot changed after planning');
          return snapshot;
        },
      };
      const gate = (name: 'secret-scan' | 'diff-review') => async () => {
        assertCurrent();
        if (commandFailed) throw new Error('Verification command failed before external review');
        await boundSnapshots.capture(taskId, workspace.linuxPath);
        const check = this.check(plan, name);
        const result = await this.options.reviews.request({
          taskId,
          planId: plan.id,
          checkId: check.id,
          checkName: name,
          snapshot: expected,
        });
        await boundSnapshots.capture(taskId, workspace.linuxPath);
        return result;
      };
      const result = await new VerificationRunner({
        commands: {
          run: async (input) => {
            await boundSnapshots.capture(taskId, workspace.linuxPath);
            const result = await this.options.commands.run(input);
            await boundSnapshots.capture(taskId, workspace.linuxPath);
            if (result.exitCode !== 0) commandFailed = true;
            return result;
          },
        },
        evidence: collector,
        snapshots: boundSnapshots,
        secretScan: { scan: gate('secret-scan') },
        diffReview: { review: gate('diff-review') },
      }).run(plan, { taskId, cwd: workspace.linuxPath });
      assertCurrent();
      if (!result.passed || this.getVerifiedPlan(taskId, headSha)?.id !== plan.id)
        throw new Error('Verification did not produce matching sealed evidence');
    } finally {
      this.running.delete(taskId);
    }
  }
  private check(plan: PersistedVerificationPlan, name: string) {
    const check = plan.checks.find((c) => c.name === name && c.kind === 'NON_COMMAND' && c.required);
    if (check === undefined) throw new Error('Required external verification check missing');
    return check;
  }
}
