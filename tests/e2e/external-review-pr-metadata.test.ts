import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  CiRunRepository, openDatabase, PullRequestEvidenceRepository, PullRequestRepository,
  RepositoryRepository, runMigrations, TaskRepository, VerificationRepository,
  VerificationReviewRepository, WorkspaceRepository,
} from '@gram/persistence';
import { createProductionGitHubServices } from '../../apps/agent/src/github-services.js';

it('publishes only the sealed external-review paths in the persisted-evidence PR body', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gram-external-pr-metadata-'));
  const db = openDatabase(join(directory, 'agent.sqlite'));
  try {
    runMigrations(db);
    new RepositoryRepository(db).upsert({ githubRepositoryId: 1, owner: 'fixture', name: 'counter', defaultBranch: 'main', localBasePath: '/repo' });
    const task = new TaskRepository(db).create({ repoId: 1, goal: 'Fix increment', taskType: 'CODING', publishMode: 'PULL_REQUEST' });
    db.prepare("UPDATE tasks SET status='VERIFYING', metadata_json=? WHERE id=?").run(JSON.stringify({ changedPaths: ['unapproved.ts'] }), task.id);
    const workspace = new WorkspaceRepository(db).create({ taskId: task.id, repoId: 1, linuxPath: '/repo/task', branch: 'fix/counter' });
    const verification = new VerificationRepository(db);
    const headSha = 'a'.repeat(40);
    const planId = verification.createPlan({ taskId: task.id, headSha, changeClass: 'OTHER', plan: { externalReviews: true } });
    const checkId = verification.createCheck({ taskId: task.id, planId, name: 'diff-review', required: true });
    const snapshot = { version: 1 as const, taskId: task.id, headSha, entries: [{ path: 'src/counter.ts', mode: '100644' as const, oid: 'b'.repeat(40) }] };
    const id = randomUUID(), runId = randomUUID();
    const reviews = new VerificationReviewRepository(db);
    reviews.create({ id, runId, taskId: task.id, workspaceId: workspace.id, workspacePath: workspace.linuxPath, branch: workspace.branch, planId, checkId, checkName: 'diff-review', headSha, snapshotDigest: createHash('sha256').update(JSON.stringify(snapshot)).digest('hex'), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    reviews.accept(id, runId, { decision: 'PASS', views: [{ path: 'src/counter.ts', digest: 'c'.repeat(64) }], approvedPaths: ['src/counter.ts'] });
    verification.finishCheck(checkId, { status: 'PASS', evidenceRef: `external-review:${id}`, approvedPaths: ['src/counter.ts'] });
    verification.sealSnapshot(planId, snapshot);
    db.prepare("UPDATE tasks SET status='PUBLISHING' WHERE id=?").run(task.id);
    const pullRequests = new PullRequestRepository(db);
    let body: string | undefined;
    const services = createProductionGitHubServices({
      secrets: { getForUse: async () => ({ withValue: use => use('fixture-token'), dispose: () => undefined }) },
      evidence: new PullRequestEvidenceRepository(db), pullRequests, ciRuns: new CiRunRepository(db),
      fetch: async (_url, request) => {
        if (request.method === 'POST') body = (JSON.parse(request.body ?? '{}') as { body: string }).body;
        return { ok: true, status: 200, text: async () => '', json: async () => request.method === 'GET' ? [] : { number: 1, html_url: 'https://github.com/fixture/counter/pull/1', state: 'open', head: { ref: workspace.branch }, base: { ref: 'main' } } };
      },
    });
    await services.pullRequests.ensureForTask({ taskId: task.id, repoId: 1, owner: 'fixture', name: 'counter', headBranch: workspace.branch, baseBranch: 'main' });
    expect(pullRequests.getLatestForTask(task.id)?.number).toBe(1);
    expect(body).toContain('## Changed Paths\n- `src/counter.ts`');
    expect(body).not.toMatch(/None recorded|unapproved\.ts|fixture-token/);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
