import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SmokeLockObserver } from './smoke-lock-observer.js';
import { createProductionGitHubServices } from './github-services.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
const context = {
  taskId: '01a13895-d4f0-7659-98d5-c53c06fed32c',
  repoId: 42,
  headSha: 'a'.repeat(40),
  correlationId: 'request-group',
  pullRequestId: null,
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-observer-'));
  roots.push(root);
  mkdirSync(join(root, 'locks'));
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE repo_locks(repo_id INTEGER, owner_task_id TEXT); CREATE TABLE pull_requests(id INTEGER, task_id TEXT, repo_id INTEGER, number INTEGER, head_branch TEXT, base_branch TEXT)',
  );
  db.exec(
    'CREATE TABLE tasks(id TEXT, repo_id INTEGER); CREATE TABLE git_commits(task_id TEXT,repo_id INTEGER,sha TEXT,branch TEXT,remote_confirmed INTEGER)',
  );
  db.prepare('INSERT INTO tasks VALUES (?,?)').run(context.taskId, 42);
  db.prepare('INSERT INTO git_commits VALUES (?,?,?,?,1)').run(context.taskId, 42, context.headSha, 'fix/task');
  const open = () => new SmokeLockObserver({ stateDirectory: root, repoId: 42 });
  return { root, db, open };
}
it('independently reads committed database and file state and appends across restarts', () => {
  const f = fixture();
  let observer = f.open();
  observer.sample(context, { requestId: 'one', boundary: 'BEFORE', endpoint: 'PR_CREATE', method: 'POST', page: null });
  f.db.prepare('INSERT INTO repo_locks VALUES (?, ?)').run(42, 'another-task');
  writeFileSync(join(f.root, 'locks/42.lock'), '{"leaseToken":"never-store"}');
  observer.sample(context, { requestId: 'one', boundary: 'AFTER', endpoint: 'PR_CREATE', method: 'POST', page: null });
  observer.close();
  observer = f.open();
  observer.sample(context, { requestId: 'two', boundary: 'BEFORE', endpoint: 'CHECK_RUNS', method: 'GET', page: 2 });
  const rows = observer.readEvidence();
  expect(rows).toHaveLength(3);
  expect(rows[0]).toMatchObject({ dbPresent: false, filePresent: false, headSha: context.headSha });
  expect(rows[1]).toMatchObject({ dbPresent: true, filePresent: true });
  expect(JSON.stringify(rows)).not.toContain('never-store');
  observer.close();
  f.db.close();
});
it('fails closed with sanitized errors on unsafe lock files', () => {
  const f = fixture();
  const observer = f.open();
  symlinkSync('/secret-path', join(f.root, 'locks/42.lock'));
  expect(() =>
    observer.sample(context, {
      requestId: 'one',
      boundary: 'BEFORE',
      endpoint: 'PR_CREATE',
      method: 'POST',
      page: null,
    }),
  ).toThrow('Smoke lock observation failed');
  expect(observer.readEvidence()).toHaveLength(0);
  observer.close();
  f.db.close();
});
it('records PR binding only after independently resolving its exact persisted identity', () => {
  const f = fixture();
  const observer = f.open();
  f.db.prepare('INSERT INTO pull_requests VALUES (?, ?, ?, ?, ?, ?)').run(7, context.taskId, 42, 1, 'fix/task', 'main');
  observer.bindPullRequest(context, { number: 1, headBranch: 'fix/task', baseBranch: 'main' });
  expect(observer.readEvidence()[0]).toMatchObject({ kind: 'PR_BINDING', pullRequestId: 7, number: 1 });
  expect(() => observer.bindPullRequest(context, { number: 2, headBranch: 'fix/task', baseBranch: 'main' })).toThrow(
    'Smoke lock observation failed',
  );
  observer.close();
  f.db.close();
});
it('rejects unconfirmed and cross-task correlation without writing invented evidence', () => {
  const f = fixture();
  const observer = f.open();
  for (const wrong of [
    { ...context, taskId: 'another-task' },
    { ...context, repoId: 43 },
    { ...context, headSha: 'b'.repeat(40) },
    { ...context, pullRequestId: 8 },
  ]) {
    expect(() =>
      observer.sample(wrong, { requestId: 'one', boundary: 'BEFORE', endpoint: 'CHECK_RUNS', method: 'GET', page: 1 }),
    ).toThrow('Smoke lock observation failed');
  }
  expect(observer.readEvidence()).toEqual([]);
  observer.close();
  f.db.close();
});
it('retains append-only samples when opened by another connection', () => {
  const f = fixture();
  const observer = f.open();
  observer.sample(context, { requestId: 'one', boundary: 'BEFORE', endpoint: 'CHECK_RUNS', method: 'GET', page: 1 });
  const journal = new DatabaseSync(join(f.root, 'smoke-lock-evidence.sqlite'));
  expect(() => journal.exec('DELETE FROM observations')).toThrow('append only');
  expect(() => journal.exec("UPDATE observations SET payload='{}'")).toThrow('append only');
  journal.close();
  observer.close();
  f.db.close();
});
it('persists real independent samples around PR creation and every CI provider request even after another task acquires a lock', async () => {
  const f = fixture();
  const observer = f.open();
  const pr = {
    number: 1,
    html_url: 'https://github.com/acme/web/pull/1',
    state: 'open',
    head: { ref: 'fix/task' },
    base: { ref: 'main' },
  };
  let requests = 0;
  const services = createProductionGitHubServices({
    observer,
    secrets: {
      getForUse: async () => ({ withValue: <T>(fn: (value: string) => T) => fn('private-token'), dispose: () => {} }),
    },
    evidence: {
      readForTask: () => ({
        taskId: context.taskId,
        summary: 'Fix',
        changedPaths: ['src/counter.ts'],
        verification: [],
      }),
    },
    pullRequests: {
      upsertForTask: (input) =>
        f.db
          .prepare('INSERT INTO pull_requests VALUES (?,?,?,?,?,?)')
          .run(7, input.taskId, input.repoId, input.number, input.headBranch, input.baseBranch),
    },
    ciRuns: { upsertCheck: () => {} },
    fetch: async (url, init) => {
      requests++;
      const rows = observer.readEvidence() as Array<{ boundary: string }>;
      expect(rows.at(-1)?.boundary).toBe('BEFORE');
      const body = url.includes('/pulls')
        ? init.method === 'POST'
          ? pr
          : []
        : url.includes('/protection/')
          ? { contexts: ['unit'] }
          : url.includes('/check-runs')
            ? { check_runs: [] }
            : [];
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    },
  });
  await services.pullRequests.ensureForTask({
    ...context,
    owner: 'acme',
    name: 'web',
    headBranch: 'fix/task',
    baseBranch: 'main',
  });
  f.db.prepare('INSERT INTO repo_locks VALUES (?,?)').run(42, 'another-task');
  writeFileSync(join(f.root, 'locks/42.lock'), 'malformed-but-present');
  await services.checks.client.listRequiredChecks({
    taskId: context.taskId,
    owner: 'acme',
    name: 'web',
    headSha: context.headSha,
    pullRequestId: 7,
    repoId: context.repoId,
    number: 1,
    baseBranch: 'main',
  });
  const rows = observer.readEvidence() as Array<{ kind: string; dbPresent?: boolean; filePresent?: boolean }>;
  expect(requests).toBe(6);
  expect(rows.filter((row) => row.kind === 'BOUNDARY')).toHaveLength(12);
  expect(rows.filter((row) => row.dbPresent && row.filePresent)).toHaveLength(8);
  expect(JSON.stringify(rows)).not.toContain('private-token');
  observer.close();
  f.db.close();
});
