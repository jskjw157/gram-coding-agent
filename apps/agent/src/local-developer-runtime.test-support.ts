import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditRepository, CommandRunRepository, LockRepository, openDatabase, RepositoryRepository, runMigrations, TaskRepository, WorkspaceRepository } from '@gram/persistence';
import { PolicyEngine } from '@gram/policy';
import { RepoLockService, type RepoLockLease } from '@gram/repo-lock';
import { FileSecretProvider, SecretRedactor } from '@gram/secrets';
import { CommandRunner, OutputCapture } from '@gram/shell';
import { WorktreeService } from '@gram/workspace';
import { PolicyWorktreeAdapter } from './command-adapters.js';
import { ordinaryExecutionAuthorization, ownedExecutionLease } from './ordinary-execution-authorization.js';
import { TrustedGitSpawner } from './trusted-git-spawner.js';
import { createLocalDeveloperRuntime } from './local-developer-runtime.js';
import { localGitFixtureSource } from './local-git-read-snapshot.test-support.js';
const cleanups: (() => void)[] = [];
export function cleanupLocalDeveloperFixtures(): void { for (const cleanup of cleanups.splice(0)) cleanup(); }
export function localDeveloperFixture(): {
  root: string; base: string; db: ReturnType<typeof openDatabase>; git(args: string[]): string;
  runtime: ReturnType<typeof createLocalDeveloperRuntime>; tasks: TaskRepository; repositories: RepositoryRepository;
  denyRegistration(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'gram-local-developer-')), base = join(root, 'base'), home = join(root, 'home');
  mkdirSync(base);mkdirSync(home);
  const git = (args: string[]) => execFileSync('/usr/bin/git', args, { cwd: base, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  git(['init', '-b', 'main']);git(['config', 'user.name', 'Fixture']);git(['config', 'user.email', 'fixture@localhost.invalid']);git(['remote', 'add', 'origin', 'https://github.com/fixture/local.git']);
  writeFileSync(join(base, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(12345)"' } }));writeFileSync(join(base, 'package-lock.json'), '{}');
  git(['add', '--', 'package.json', 'package-lock.json']);git(['commit', '-m', 'fixture initial']);
  const db = openDatabase(join(root, 'state.db'));runMigrations(db);cleanups.push(() => { db.close();rmSync(root, { recursive: true, force: true }); });
  const tasks = new TaskRepository(db), repositories = new RepositoryRepository(db), workspaces = new WorkspaceRepository(db), locks = new LockRepository(db), runs = new CommandRunRepository(db);
  const held = new Map<string, RepoLockLease>();const lockDirectory = join(root, 'locks');
  const lockService = new RepoLockService({ tasks, locks, lockDirectory });
  const trackedLocks = { acquire: async (repoId: number, taskId: string) => { const lease = await lockService.acquire(repoId, taskId);held.set(taskId, lease);return { release: async () => { try { await lease.release(); } finally { held.delete(taskId); } } }; } };
  const redactor = new SecretRedactor([]), outputCapture = new OutputCapture({ homeDir: home, redactor }), policy = new PolicyEngine(), approvals = { consume: async () => false };
  const gitSpawner = new TrustedGitSpawner({ contextForTask: taskId => ({ basePath: base, worktreePath: join(home, '.gram-agent', 'worktrees', '7', taskId), owner: 'fixture', name: 'local', defaultBranch: 'main' }), secrets: new FileSecretProvider(join(root, 'secrets')) });
  const gitCommands = new CommandRunner({ policy, approvals, spawner: gitSpawner, commandRuns: runs, outputCapture, homeDir: home });
  const worktreesService = new WorktreeService({ homeDir: home, git: new PolicyWorktreeAdapter({ runner: gitCommands }), workspaces,
    pathMapper: { toWindows: async path => 'fixture-only:' + path } });
  let allowRegistration = true;
  const runtime = createLocalDeveloperRuntime({ gitSnapshotDirectory: join(root, 'git-snapshots'),
    withProject: async (_input, operation) => operation({ canonicalPath: base, identity: 'fixture', gitSnapshotSource: localGitFixtureSource(base) }),
    withRegisteredProject: async (repository, operation) => operation({ canonicalPath: repository.localBasePath, identity: 'fixture', gitSnapshotSource: localGitFixtureSource(repository.localBasePath) }),
    repositories, tasks, workspaces, commandRuns: runs, audit: new AuditRepository(db), locks: trackedLocks,
    ownsLease: (taskId, repoId) => ownedExecutionLease({ held, locks, lockDirectory }, taskId, repoId) !== undefined,
    worktrees: worktreesService, commandAuthorization: ordinaryExecutionAuthorization({ tasks, workspaces, held, locks, lockDirectory }),
    policy, approvals, outputCapture, homeDir: home, redactor,
    github: { getRepository: async () => ({ id: 7, owner: 'fixture', name: 'local', defaultBranch: 'main' }) },
    canRegister: () => allowRegistration,
  });
  return { root, base, db, git, runtime, tasks, repositories, denyRegistration: () => { allowRegistration = false; } };
}
