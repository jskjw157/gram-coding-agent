import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { openDatabase, runMigrations, RepositoryRepository, TaskRepository, WorkspaceRepository, VerificationRepository, CommandRunRepository } from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { CommandRunner, NodeProcessSpawner, OutputCapture } from '@gram/shell';
import { SecretRedactor } from '@gram/secrets';
import { EvidenceCollector, VerificationRunner } from '@gram/verification';
import { TaskVerificationSnapshots } from './verification-snapshot.js';

it('refuses successful verification in a sibling instead of the registered failing workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gram158-workspace-proof-'));
  const db = openDatabase(':memory:');
  try {
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    git(root, ['init', 'registered']);
    const a = join(root, 'registered'); const b = join(root, 'sibling');
    git(a, ['config', 'user.name', 'Fixture']); git(a, ['config', 'user.email', 'fixture@example.test']);
    writeFileSync(join(a, 'app.txt'), 'base');
    writeFileSync(join(a, 'check.cjs'), "process.exit(require('node:fs').readFileSync('app.txt','utf8') === 'good' ? 0 : 1);\n");
    git(a, ['add', '.']); git(a, ['commit', '-m', 'baseline']); git(root, ['clone', a, b]);
    const headSha = git(a, ['rev-parse', 'HEAD']);
    writeFileSync(join(a, 'app.txt'), 'bad'); writeFileSync(join(b, 'app.txt'), 'good');
    runMigrations(db);
    new RepositoryRepository(db).upsert({ githubRepositoryId: 158, owner: 'fixture', name: 'repo', defaultBranch: 'main', localBasePath: a });
    const task = new TaskRepository(db).create({ goal: 'check', taskType: 'CODING', publishMode: 'PULL_REQUEST', repoId: 158 });
    const workspaces = new WorkspaceRepository(db);
    workspaces.create({ taskId: task.id, repoId: 158, linuxPath: a, branch: 'fixture', headSha });
    const repository = new VerificationRepository(db); const evidence = new EvidenceCollector(repository);
    const commands = new CommandRunner({ policy: new PolicyEngine(), approvals: { consume: async () => false }, spawner: new NodeProcessSpawner(), commandRuns: new CommandRunRepository(db), outputCapture: new OutputCapture({ homeDir: root, redactor: new SecretRedactor() }), homeDir: root });
    const runner = new VerificationRunner({
      commands, evidence, snapshots: new TaskVerificationSnapshots({ runner: commands, workspaces }),
      secretScan: { scan: async () => ({ passed: true, evidenceRef: 'fixture:scan' }) },
      diffReview: { review: async () => ({ passed: true, evidenceRef: 'fixture:review', changedPaths: ['app.txt'] }) },
    });
    const plan = evidence.persistPlan({ taskId: task.id, headSha, plan: { changeClass: 'OTHER', checks: [
      { name: 'test', kind: 'COMMAND', required: true, status: 'PENDING', command: 'node check.cjs' },
      { name: 'diff-review', kind: 'NON_COMMAND', required: true, status: 'PENDING' },
    ] } });
    await expect(runner.run(plan, { taskId: task.id, cwd: b })).rejects.toThrow(/workspace|cwd/i);
    expect(repository.getBoundPlan(task.id, headSha)).toBeUndefined();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
