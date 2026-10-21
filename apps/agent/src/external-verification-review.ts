import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  VerificationReviewIdentityInput,
  VerificationReviewReadInput,
  VerificationReviewSubmitInput,
  type VerificationReviewIdentity,
  type VerificationReviewRead,
  type VerificationReviewSubmission,
} from '@gram/mcp';
import type {
  LockRepository,
  TaskRepository,
  WorkspaceRepository,
  VerificationRepository,
  VerificationReviewRepository,
  VerificationSnapshot,
  StoredVerificationReview,
  VerificationReviewName,
} from '@gram/persistence';
import type { VerificationGateResult } from '@gram/verification';
import type { ReviewFileView } from './verification-review-source.js';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ExternalVerificationReviewOptions {
  tasks: TaskRepository;
  workspaces: WorkspaceRepository;
  locks: LockRepository;
  reviews: VerificationReviewRepository;
  verification: VerificationRepository;
  ownsLease(taskId: string, leaseToken: string): boolean;
  snapshots: { capture(taskId: string, cwd?: string): Promise<VerificationSnapshot> };
  source: { read(taskId: string, snapshot: VerificationSnapshot, path: string): Promise<ReviewFileView> };
  timeoutMs?: number;
}
export interface PendingVerificationReview extends VerificationReviewIdentity {
  checkName: VerificationReviewName;
  expiresAt: string;
  paths: string[];
}
interface Pending {
  record: StoredVerificationReview;
  snapshot: VerificationSnapshot;
  leaseToken: string;
  seen: Map<string, string>;
  resolve(value: VerificationGateResult & { changedPaths?: readonly string[] }): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
/** Read-only rendezvous within the existing authenticated controller trust domain. */
export class ExternalVerificationReview {
  private readonly runId = randomUUID();
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private readonly timeoutMs: number;
  constructor(private readonly options: ExternalVerificationReviewOptions) {
    this.timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30 * 60 * 1000)
      throw new Error('Invalid verification review timeout');
    options.reviews.interruptPending();
  }
  assertActive(taskId: string) {
    const task = this.options.tasks.get(taskId),
      workspace = this.options.workspaces.getByTaskId(taskId);
    if (
      this.closed ||
      task?.status !== 'VERIFYING' ||
      workspace === undefined ||
      workspace.taskId !== taskId ||
      workspace.repoId !== task.repoId ||
      realpathSync(workspace.linuxPath) !== resolve(workspace.linuxPath)
    )
      throw new Error('Verification task/workspace is not active');
    const lease = this.options.locks.get(workspace.repoId);
    if (
      lease?.ownerTaskId !== taskId ||
      Date.parse(lease.leaseUntil) <= Date.now() ||
      !this.options.ownsLease(taskId, lease.leaseToken)
    )
      throw new Error('Verification repository lease is not active');
    return { ...workspace, leaseToken: lease.leaseToken };
  }
  request(input: {
    taskId: string;
    planId: number;
    checkId: number;
    checkName: VerificationReviewName;
    snapshot: VerificationSnapshot;
  }): Promise<VerificationGateResult & { changedPaths?: readonly string[] }> {
    const bound = this.assertActive(input.taskId);
    const snapshot = structuredClone(input.snapshot);
    if (
      snapshot.taskId !== input.taskId ||
      snapshot.entries.length === 0 ||
      snapshot.entries.length > 100 ||
      !this.options.verification.isCurrentPlan(input.taskId, input.planId, snapshot.headSha)
    )
      throw new Error('Invalid current verification snapshot/plan');
    const record = this.options.reviews.create({
      id: randomUUID(),
      taskId: input.taskId,
      workspaceId: bound.id,
      workspacePath: bound.linuxPath,
      branch: bound.branch,
      planId: input.planId,
      checkId: input.checkId,
      checkName: input.checkName,
      headSha: snapshot.headSha,
      snapshotDigest: hash(snapshot),
      runId: this.runId,
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString(),
    });
    return new Promise((resolveResult, reject) => {
      const entry: Pending = {
        record,
        snapshot,
        leaseToken: bound.leaseToken,
        seen: new Map(),
        resolve: resolveResult,
        reject,
        timer: setTimeout(() => this.stop(entry, 'FAILED', 'Verification review timed out'), this.timeoutMs),
      };
      this.pending.set(record.id, entry);
    });
  }
  get(taskId: string): PendingVerificationReview | null {
    const entry = [...this.pending.values()].find((e) => e.record.taskId === taskId);
    if (entry === undefined) return null;
    const r = entry.record;
    this.assertPending(this.identity(r));
    return {
      ...this.identity(r),
      checkName: r.checkName,
      expiresAt: r.expiresAt,
      paths: entry.snapshot.entries.map((e) => e.path),
    };
  }
  async read(raw: VerificationReviewRead): Promise<ReviewFileView> {
    const input = VerificationReviewReadInput.parse(raw);
    const entry = this.assertPending(input);
    if (!entry.snapshot.entries.some((e) => e.path === input.path))
      throw new Error('Review path is outside the snapshot');
    await this.assertSnapshot(entry);
    this.assertPending(input);
    const file = await this.options.source.read(input.taskId, structuredClone(entry.snapshot), input.path);
    await this.assertSnapshot(entry);
    this.assertPending(input);
    const digest = hash({ binding: this.identity(entry.record), path: input.path, view: file });
    entry.seen.set(input.path, digest);
    return { ...file, digest };
  }
  async submit(raw: VerificationReviewSubmission): Promise<{ accepted: true }> {
    const input = VerificationReviewSubmitInput.parse(raw),
      entry = this.assertPending(input);
    const expected = entry.snapshot.entries.map((e) => e.path),
      acks = input.acknowledgements;
    if (input.status === 'PASS') {
      if (
        acks.length !== expected.length ||
        new Set(acks.map((a) => a.path)).size !== acks.length ||
        acks.some((a) => !expected.includes(a.path) || entry.seen.get(a.path) !== a.digest)
      )
        throw new Error('Every snapshot path must be read and acknowledged for this review');
      if (
        new Set(input.approvedPaths).size !== input.approvedPaths.length ||
        input.approvedPaths.some((p) => !expected.includes(p)) ||
        (entry.record.checkName === 'diff-review' ? input.approvedPaths.length === 0 : input.approvedPaths.length !== 0)
      )
        throw new Error('Invalid reviewed publication paths');
    } else if (acks.length !== 0 || input.approvedPaths.length !== 0)
      throw new Error('Failed review cannot approve paths');
    await this.assertSnapshot(entry);
    this.assertPending(input);
    const accepted = this.options.reviews.accept(entry.record.id, this.runId, {
      decision: input.status,
      views: acks,
      approvedPaths: input.approvedPaths,
    });
    this.remove(entry);
    entry.resolve({
      passed: input.status === 'PASS',
      evidenceRef: accepted.evidenceRef,
      ...(input.status === 'FAIL' ? { reason: 'External verification review rejected the snapshot' } : {}),
      ...(entry.record.checkName === 'diff-review' && input.status === 'PASS'
        ? { changedPaths: [...input.approvedPaths] }
        : {}),
    });
    return { accepted: true };
  }
  fail(raw: VerificationReviewIdentity): { failed: true } {
    const input = VerificationReviewIdentityInput.parse(raw);
    this.stop(this.assertPending(input), 'FAILED', 'External controller failed verification review');
    return { failed: true };
  }
  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) this.stop(entry, 'INTERRUPTED', 'Verification review capability closed');
  }
  private identity(r: StoredVerificationReview): VerificationReviewIdentity {
    return {
      taskId: r.taskId,
      reviewId: r.id,
      workspaceId: r.workspaceId,
      planId: r.planId,
      checkId: r.checkId,
      headSha: r.headSha,
      snapshotDigest: r.snapshotDigest,
    };
  }
  private assertPending(input: VerificationReviewIdentity): Pending {
    const entry = this.pending.get(input.reviewId);
    if (
      entry === undefined ||
      !isDeepStrictEqual(this.identity(entry.record), {
        taskId: input.taskId,
        reviewId: input.reviewId,
        workspaceId: input.workspaceId,
        planId: input.planId,
        checkId: input.checkId,
        headSha: input.headSha,
        snapshotDigest: input.snapshotDigest,
      })
    )
      throw new Error('Unknown or mismatched verification review');
    const current = this.options.reviews.get(input.reviewId),
      bound = this.assertActive(input.taskId),
      r = entry.record;
    if (
      current?.state !== 'PENDING' ||
      current.runId !== this.runId ||
      Date.parse(r.expiresAt) <= Date.now() ||
      bound.id !== r.workspaceId ||
      bound.linuxPath !== r.workspacePath ||
      bound.branch !== r.branch ||
      bound.leaseToken !== entry.leaseToken ||
      !this.options.verification.isCurrentPlan(r.taskId, r.planId, r.headSha) ||
      this.options.verification.getCheck(r.checkId)?.status !== 'PENDING'
    )
      throw new Error('Unknown or stale verification review');
    return entry;
  }
  private async assertSnapshot(entry: Pending): Promise<void> {
    const snapshot = await this.options.snapshots.capture(entry.record.taskId, entry.record.workspacePath);
    if (!isDeepStrictEqual(snapshot, entry.snapshot)) throw new Error('Verification review snapshot changed');
  }
  private remove(entry: Pending): void {
    clearTimeout(entry.timer);
    this.pending.delete(entry.record.id);
  }
  private stop(entry: Pending, state: 'FAILED' | 'INTERRUPTED', message: string): void {
    this.remove(entry);
    this.options.reviews.stop(entry.record.id, this.runId, state);
    entry.reject(new Error(message));
  }
}
