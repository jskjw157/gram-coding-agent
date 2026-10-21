import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TaskId } from '@gram/domain';
import { FileService, WorkspacePathGuard } from '@gram/filesystem';
import { CodingSubmitInput, type CodingSubmission } from '@gram/mcp';
import type { CodingStepPhase, CodingStepRepository, LockRepository, StoredCodingStep, TaskRepository, WorkspaceRepository } from '@gram/persistence';
import type { SecretRedactor } from '@gram/secrets';
import type { AnalyzePort, InstructionsPort, ModifyPort, RepositoryInstructions, TaskAnalysis, TaskWorkspace } from '@gram/task-engine';

const digest = (content: string): string => createHash('sha256').update(content).digest('hex');
const MAX_FILE_BYTES = 262144;
export interface ExternalCodingOptions {
  tasks: TaskRepository;
  workspaces: WorkspaceRepository;
  locks: LockRepository;
  steps: CodingStepRepository;
  ownsLease(taskId: TaskId, leaseToken: string): boolean;
  redactor: SecretRedactor;
  stepTimeoutMs?: number;
}
export interface PendingCodingStep {
  taskId: string;
  stepId: string;
  phase: CodingStepPhase;
  expiresAt: string;
  request: Record<string, unknown>;
}
interface Pending {
  record: StoredCodingStep;
  view: PendingCodingStep;
  leaseToken: string;
  finish(input: CodingSubmission): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/** An existing authenticated control-plane principal may answer one live step.
 * Step IDs are public correlation IDs, never credentials or delegated grants. */
export class ExternalCodingCapability implements InstructionsPort, AnalyzePort, ModifyPort {
  private readonly runId = randomUUID();
  private readonly pending = new Map<string, Pending>();
  private readonly files: FileService;
  private readonly guard: WorkspacePathGuard;
  private readonly timeoutMs: number;
  private closed = false;

  constructor(private readonly options: ExternalCodingOptions) {
    this.timeoutMs = options.stepTimeoutMs ?? 30 * 60 * 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30 * 60 * 1000) {
      throw new Error('Invalid coding step timeout');
    }
    this.guard = new WorkspacePathGuard(options.workspaces);
    this.files = new FileService(this.guard);
    // A dead process cannot safely replay an uncertain filesystem operation.
    options.steps.interruptPending();
  }

  load(workspace: TaskWorkspace, taskId?: TaskId): Promise<RepositoryInstructions> {
    if (taskId === undefined) return Promise.reject(new Error('Coding instructions require task identity'));
    const bound = this.binding(taskId, workspace);
    let instructions: RepositoryInstructions;
    try { instructions = this.readInstructions(taskId); }
    catch (error) { return Promise.reject(error); }
    const expected = digest(JSON.stringify(instructions));
    return this.request(taskId, bound, 'INSTRUCTIONS', { ...instructions, digest: expected }, (input) => {
      if (input.phase !== 'INSTRUCTIONS' || input.digest !== expected || digest(JSON.stringify(this.readInstructions(taskId))) !== expected) throw new Error('Instruction acknowledgement does not match');
      return instructions;
    });
  }

  analyze(input: Parameters<AnalyzePort['analyze']>[0]): Promise<TaskAnalysis> {
    const bound = this.binding(input.task.taskId, input.workspace);
    return this.request(input.task.taskId, bound, 'ANALYZE', {
      goal: this.options.redactor.redact(this.options.tasks.get(input.task.taskId)?.goal ?? ''),
      instructions: input.instructions,
    }, (result) => {
      if (result.phase !== 'ANALYZE') throw new Error('Coding phase mismatch');
      const files = [...new Set(result.files)];
      if (files.length !== result.files.length) throw new Error('Duplicate analysis paths');
      for (const path of files) this.path(input.task.taskId, path, true);
      this.safeText(result.summary);
      return { summary: result.summary, files };
    });
  }

  modify(input: Parameters<ModifyPort['modify']>[0]): ReturnType<ModifyPort['modify']> {
    const taskId = input.task.taskId;
    const bound = this.binding(taskId, input.workspace);
    // The analysis instance comes from the local runner, not from MCP input.
    const allowed = new Set(input.analysis.files);
    return this.request(taskId, bound, 'MODIFY', { summary: input.analysis.summary, files: [...allowed] }, (result) => {
      if (result.phase !== 'MODIFY') throw new Error('Coding phase mismatch');
      const seen = new Set<string>();
      for (const patch of result.patches) {
        if (!allowed.has(patch.path) || seen.has(patch.path)) throw new Error('Unapproved or duplicate mutation path');
        if ([...seen].some((path) => path.startsWith(patch.path + '/') || patch.path.startsWith(path + '/'))) {
          throw new Error('Conflicting mutation path hierarchy');
        }
        seen.add(patch.path);
        this.path(taskId, patch.path, true);
        this.safeText(patch.content);
        let old: string | null = null;
        try { old = this.readSource(taskId, patch.path); }
        catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        if ((old === null ? null : digest(old)) !== patch.expectedSha256) throw new Error('Stale file precondition');
        if (old === patch.content) throw new Error('No-op mutation is not a coding result');
      }
      // Validation is deliberately complete before claim or mutation. All IO is
      // synchronous, so no other MCP callback can interleave within this turn.
      return { sha: bound.headSha ?? '', apply: (beforeWrite: () => void) => {
        for (const patch of result.patches) {
          beforeWrite();
          this.files.writeText(taskId, patch.path, patch.content);
        }
      } };
    });
  }

  get(taskId: string): PendingCodingStep | null {
    const entry = [...this.pending.values()].find((value) => value.record.taskId === taskId);
    if (entry === undefined) return null;
    this.assertPending(taskId, entry.record.id);
    return structuredClone(entry.view);
  }

  read(taskId: string, stepId: string, path: string): { content: string; sha256: string } {
    this.assertPending(taskId, stepId);
    this.path(taskId, path, false);
    const content = this.readSource(taskId, path);
    return { content: this.safeText(content), sha256: digest(content) };
  }

  submit(raw: CodingSubmission): { accepted: true } {
    const input = CodingSubmitInput.parse(raw);
    const entry = this.assertPending(input.taskId, input.stepId);
    if (entry.record.phase !== input.phase) throw new Error('Coding phase mismatch');
    entry.finish(input);
    return { accepted: true };
  }

  fail(taskId: string, stepId: string): { failed: true } {
    const entry = this.assertPending(taskId, stepId);
    this.stop(entry, 'FAILED', 'External controller failed coding step');
    return { failed: true };
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) this.stop(entry, 'INTERRUPTED', 'Coding capability closed');
  }

  private binding(taskId: string, expected: TaskWorkspace) {
    const task = this.options.tasks.get(taskId);
    const workspace = this.options.workspaces.getByTaskId(taskId);
    if (this.closed || task?.status !== 'RUNNING' || workspace === undefined ||
      workspace.taskId !== taskId || task.repoId !== workspace.repoId ||
      workspace.linuxPath !== expected.linuxPath || workspace.branch !== expected.branch) throw new Error('Coding task/workspace is not active');
    const lease = this.options.locks.get(workspace.repoId);
    if (lease?.ownerTaskId !== taskId || Date.parse(lease.leaseUntil) <= Date.now() || !this.options.ownsLease(taskId, lease.leaseToken)) throw new Error('Coding repository lease is not active');
    if (realpathSync(workspace.linuxPath) !== resolve(workspace.linuxPath)) throw new Error('Coding workspace root must be canonical');
    return { ...workspace, leaseToken: lease.leaseToken };
  }

  private assertPending(taskId: string, stepId: string, expectedState: 'PENDING' | 'APPLYING' = 'PENDING'): Pending {
    const entry = this.pending.get(stepId);
    if (entry === undefined || entry.record.taskId !== taskId || this.closed) throw new Error('Unknown or stale coding step');
    const current = this.options.steps.get(stepId);
    const bound = this.binding(taskId, { linuxPath: entry.record.workspacePath, branch: entry.record.branch });
    if (current?.state !== expectedState || current.runId !== this.runId ||
      bound.id !== entry.record.workspaceId || bound.leaseToken !== entry.leaseToken ||
      Date.parse(entry.record.expiresAt) <= Date.now()) throw new Error('Unknown or stale coding step');
    return entry;
  }

  private request<T>(taskId: string, workspace: ReturnType<ExternalCodingCapability['binding']>, phase: CodingStepPhase,
    payload: Record<string, unknown>, validate: (input: CodingSubmission) => T & { apply?: (beforeWrite: () => void) => void }): Promise<T> {
    if ([...this.pending.values()].some((entry) => entry.record.taskId === taskId)) return Promise.reject(new Error('A coding step is already pending'));
    const record = this.options.steps.create({ id: randomUUID(), taskId, workspaceId: workspace.id,
      workspacePath: workspace.linuxPath, branch: workspace.branch, phase, runId: this.runId,
      expiresAt: new Date(Date.now() + this.timeoutMs).toISOString() });
    return new Promise<T>((resolveResult, reject) => {
      const entry: Pending = { record, leaseToken: workspace.leaseToken,
        view: { taskId, stepId: record.id, phase, expiresAt: record.expiresAt, request: payload },
        reject, timer: setTimeout(() => this.stop(entry, 'FAILED', 'Coding step timed out'), this.timeoutMs),
        finish: (input) => {
          const result = validate(input);
          this.assertPending(taskId, record.id);
          if (!this.options.steps.claim(record.id, taskId, this.runId)) throw new Error('Coding step was already claimed');
          try {
            result.apply?.(() => { this.assertPending(taskId, record.id, 'APPLYING'); });
            this.assertPending(taskId, record.id, 'APPLYING');
            this.options.steps.finish(record.id, this.runId, 'SUCCEEDED');
            this.remove(entry);
            // Never expose an execution callback or controller-supplied SHA.
            const { apply: _apply, ...value } = result;
            void _apply;
            resolveResult(value as T);
          } catch {
            this.stop(entry, 'FAILED', 'Coding mutation failed; inspect workspace before recovery');
            throw new Error('Coding mutation failed; inspect workspace before recovery');
          }
        },
      };
      this.pending.set(record.id, entry);
    });
  }

  private remove(entry: Pending): void {
    clearTimeout(entry.timer);
    this.pending.delete(entry.record.id);
  }

  private stop(entry: Pending, state: 'FAILED' | 'INTERRUPTED', message: string): void {
    this.remove(entry);
    const current = this.options.steps.get(entry.record.id);
    if (current?.state === 'PENDING' || current?.state === 'APPLYING') this.options.steps.finish(entry.record.id, this.runId, state);
    entry.reject(new Error(message));
  }

  private readSource(taskId: string, path: string): string {
    return this.safeText(this.files.readTextStrict(taskId, path));
  }

  private readInstructions(taskId: string): RepositoryInstructions {
    try {
      this.path(taskId, 'AGENTS.md', false);
      return { content: this.readSource(taskId, 'AGENTS.md'), source: 'AGENTS.md' };
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      return { content: '', source: 'AGENTS.md (absent)' };
    }
  }

  private safeText(content: string): string {
    if (Buffer.from(content, 'utf8').toString('utf8') !== content || Buffer.byteLength(content) > MAX_FILE_BYTES || content.includes('\0') || this.options.redactor.redact(content) !== content) {
      throw new Error('Coding content is oversized, binary, or contains sensitive data');
    }
    return content;
  }

  private path(taskId: string, path: string, writing: boolean): void {
    const parts = path.split('/');
    if (path.length > 1024 || parts.some((part) => part === '' || part.startsWith('.') || part.includes('\\') || part.includes('\0') ||
      /^(?:\.git(?:hub)?|\.ssh|\.aws|\.env(?:\..*)?|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i.test(part) || /\.(?:pem|p12|pfx|key)$/i.test(part))) {
      throw new Error('Coding path is not an ordinary task source path');
    }
    const workspace = this.options.workspaces.getByTaskId(taskId);
    if (workspace === undefined) throw new Error('Coding workspace missing');
    let current = workspace.linuxPath;
    for (const part of parts) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('Coding symlink paths are forbidden');
      } catch (error) {
        if (!(writing && error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    const target = writing ? this.guard.resolveForWrite(taskId, path) : this.guard.resolveExisting(taskId, path);
    try {
      const info = statSync(target);
      if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE_BYTES) throw new Error('Coding target must be a bounded ordinary file');
    } catch (error) {
      if (!(writing && error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
}
