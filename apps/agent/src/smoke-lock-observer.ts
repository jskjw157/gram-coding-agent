import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface SmokeContext {
  taskId: string;
  repoId: number;
  headSha: string;
  correlationId: string;
  pullRequestId: number | null;
}
export interface SmokeBoundary {
  requestId: string;
  boundary: 'BEFORE' | 'AFTER';
  endpoint: 'PR_FIND' | 'PR_CREATE' | 'RULES' | 'STATUSES' | 'PROTECTION' | 'CHECK_RUNS';
  method: string;
  page: number | null;
  outcome?: 'RESPONSE' | 'TRANSPORT_ERROR';
  status?: number;
}
export interface SmokeBoundaryObserver {
  readonly repoId: number;
  sample(context: SmokeContext, boundary: SmokeBoundary): void;
  bindPullRequest(context: SmokeContext, pr: { number: number; headBranch: string; baseBranch: string }): void;
}

// This opt-in diagnostic is independent of the mutation connection and never
// makes lock presence an operational policy. Samples prove boundary instants,
// not continuous absence during an asynchronous network request.
export class SmokeLockObserver implements SmokeBoundaryObserver {
  readonly repoId: number;
  private readonly reader: DatabaseSync;
  private readonly journal: DatabaseSync;
  private readonly sessionId = randomUUID();
  constructor(private readonly options: { stateDirectory: string; repoId: number }) {
    this.repoId = options.repoId;
    this.reader = new DatabaseSync(join(options.stateDirectory, 'agent.sqlite'), { readOnly: true });
    let journal: DatabaseSync | undefined;
    try {
      this.reader.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000');
      const path = join(options.stateDirectory, 'smoke-lock-evidence.sqlite');
      const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          (stat.mode & 0o077) !== 0 ||
          (process.getuid !== undefined && stat.uid !== process.getuid())
        )
          throw new Error('Unsafe evidence journal');
      } finally {
        closeSync(fd);
      }
      this.journal = journal = new DatabaseSync(path);
      this.journal.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS observations (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, payload TEXT NOT NULL) STRICT; CREATE TRIGGER IF NOT EXISTS observations_no_update BEFORE UPDATE ON observations BEGIN SELECT RAISE(ABORT, 'append only'); END; CREATE TRIGGER IF NOT EXISTS observations_no_delete BEFORE DELETE ON observations BEGIN SELECT RAISE(ABORT, 'append only'); END;",
      );
    } catch {
      journal?.close();
      this.reader.close();
      throw new Error('Smoke observer startup failed');
    }
  }
  private validate(context: SmokeContext): void {
    if (context.repoId !== this.repoId || !/^[0-9a-f]{40}$/u.test(context.headSha)) throw new Error('Invalid context');
    const published = this.reader
      .prepare(
        'SELECT g.branch FROM git_commits g JOIN tasks t ON t.id=g.task_id AND t.repo_id=g.repo_id WHERE g.task_id=? AND g.repo_id=? AND g.sha=? AND g.remote_confirmed=1',
      )
      .get(context.taskId, context.repoId, context.headSha);
    if (published === undefined) throw new Error('Unconfirmed context');
    if (
      context.pullRequestId !== null &&
      this.reader
        .prepare('SELECT id FROM pull_requests WHERE id=? AND task_id=? AND repo_id=? AND head_branch=?')
        .get(context.pullRequestId, context.taskId, context.repoId, published.branch ?? null) === undefined
    )
      throw new Error('Unbound PR');
  }
  private append(payload: Record<string, unknown>): void {
    this.journal
      .prepare('INSERT INTO observations(id,payload) VALUES (?,?)')
      .run(
        randomUUID(),
        JSON.stringify({
          ...payload,
          sessionId: this.sessionId,
          observerPid: process.pid,
          observedAt: new Date().toISOString(),
          schemaVersion: 1,
        }),
      );
  }
  sample(context: SmokeContext, boundary: SmokeBoundary): void {
    try {
      this.validate(context);
      const dbObservedAt = new Date().toISOString();
      const dbPresent =
        this.reader.prepare('SELECT 1 FROM repo_locks WHERE repo_id=?').get(context.repoId) !== undefined;
      let filePresent = false;
      const fileObservedAt = new Date().toISOString();
      try {
        const stat = lstatSync(join(this.options.stateDirectory, 'locks', `${context.repoId}.lock`));
        // Existence is sufficient: no lease content (including secrets) is read.
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe lock type');
        filePresent = true;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      this.append({ kind: 'BOUNDARY', ...context, ...boundary, dbObservedAt, fileObservedAt, dbPresent, filePresent });
    } catch {
      throw new Error('Smoke lock observation failed');
    }
  }
  bindPullRequest(context: SmokeContext, pr: { number: number; headBranch: string; baseBranch: string }): void {
    try {
      this.validate(context);
      const row = this.reader
        .prepare(
          'SELECT p.id FROM pull_requests p JOIN git_commits g ON g.task_id=p.task_id AND g.repo_id=p.repo_id AND g.branch=p.head_branch WHERE p.task_id=? AND p.repo_id=? AND p.number=? AND p.head_branch=? AND p.base_branch=? AND g.sha=? AND g.remote_confirmed=1',
        )
        .get(context.taskId, context.repoId, pr.number, pr.headBranch, pr.baseBranch, context.headSha);
      if (row === undefined) throw new Error('Missing PR');
      this.append({ kind: 'PR_BINDING', ...context, pullRequestId: row.id, number: pr.number });
    } catch {
      throw new Error('Smoke lock observation failed');
    }
  }
  readEvidence(): unknown[] {
    return this.journal
      .prepare('SELECT payload FROM observations ORDER BY sequence')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as unknown);
  }
  close(): void {
    this.reader.close();
    this.journal.close();
  }
}
