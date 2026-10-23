import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditRepository, CommandRunRepository, RepositoryRepository, StoredRepository, TaskRepository, WorkspaceRepository } from '@gram/persistence';
import type { PolicyEngine } from '@gram/policy';
import { RepositoryProfiler, type RepositoryInspection } from '@gram/repo-registry';
import { SecretRedactor } from '@gram/secrets';
import { CommandRunner, LinuxIsolatedProcessSpawner, type ApprovalConsumptionPort, type CommandOutputCapturePort } from '@gram/shell';
import { LocalCommandDispatcher } from '@gram/task-engine';
import { createTaskBranchName, type WorktreeService } from '@gram/workspace';
import { LocalDeveloper, type LocalDeveloperOptions, type LocalDeveloperProject } from './local-developer.js';
import { readTrustedLocalGit } from './trusted-git-spawner.js';
import { screenLocalText } from './local-content-screen.js';

export interface LocalDeveloperRuntimeOptions {
  gitSnapshotDirectory: string;
  withProject: LocalDeveloperOptions['withProject'];
  withRegisteredProject<T>(repository: StoredRepository, operation: (project: LocalDeveloperProject) => Promise<T>): Promise<T>;
  repositories: RepositoryRepository;
  tasks: TaskRepository;
  workspaces: WorkspaceRepository;
  commandRuns: CommandRunRepository;
  audit: AuditRepository;
  locks: { acquire(repositoryId: number, taskId: string): Promise<{ release(): Promise<void> }> };
  ownsLease(taskId: string, repositoryId: number): boolean;
  /** Synchronous current Task/RepoLock check, immediately before persistence. */
  canRegister(repositoryId: number): boolean;
  worktrees: WorktreeService;
  commandAuthorization(taskId: string): { workspace: string; identity: string } | undefined;
  policy: PolicyEngine;
  approvals: ApprovalConsumptionPort;
  outputCapture: CommandOutputCapturePort;
  homeDir: string;
  github: { getRepository(owner: string, name: string): Promise<{ id: number; owner: string; name: string; defaultBranch: string }> };
  redactor: LocalDeveloperOptions['redactor'];
}
const denied = () => new Error('Local developer runtime denied or failed');
const PROFILE_FILES = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'build.gradle', 'gradlew', 'pom.xml', 'pyproject.toml', 'package.json'] as const;
/** Read only fixed, bounded, direct regular metadata files. RepoInspector follows
 * symlinks and is intentionally not used on owner-selected business trees. */
async function inspectProfile(base: string): Promise<RepositoryInspection> {
  const files: string[] = [];
  let packageJson: RepositoryInspection['packageJson'];
  for (const name of PROFILE_FILES) {
    const path = join(base, name);
    let stat;
    try { stat = await lstat(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;throw denied(); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw denied();
    files.push(name);
    if (name !== 'package.json') continue;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 256n * 1024n) throw denied();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      const read = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat({ bigint: true });
      if (read.bytesRead !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw denied();
      const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw denied();
      const scripts: unknown = 'scripts' in parsed ? parsed.scripts : undefined;
      if (scripts !== undefined && (!scripts || typeof scripts !== 'object' || Array.isArray(scripts))) throw denied();
      packageJson = scripts === undefined ? {} : { scripts: scripts as Record<string, unknown> };
    } finally { await file.close(); }
  }
  return { files, ...(packageJson === undefined ? {} : { packageJson }) };
}
async function cleanHead(project: LocalDeveloperProject, snapshotDirectory: string): Promise<string> {
  if (!project.gitSnapshotSource) throw denied();
  const options = { snapshotDirectory, source: project.gitSnapshotSource };
  const status = await readTrustedLocalGit(project.canonicalPath, { operation: 'status' }, options);
  if (status.stdout !== '' || status.partialCapture === true) throw denied();
  const tracked = await readTrustedLocalGit(project.canonicalPath, { operation: 'tracked' }, options);
  // Do not let assume-unchanged/skip-worktree index flags hide local edits.
  if (tracked.stdout.split('\0').filter(Boolean).some(entry => !entry.startsWith('H '))) throw denied();
  try { await lstat(join(project.canonicalPath, '.gitmodules'));throw denied(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw denied(); }
  const head = (await readTrustedLocalGit(project.canonicalPath, { operation: 'head' }, options)).stdout.trim();
  if (!/^[a-f0-9]{40}$/u.test(head)) throw denied();
  return head;
}

/** Real controller composition. No request selects an executable, shell,
 * environment, sandbox entry or execution profile. Commands run only in a new
 * persisted isolated worktree of a clean registered base's committed HEAD. */
export function createLocalDeveloperRuntime(options: LocalDeveloperRuntimeOptions): LocalDeveloper {
  const readGit = (project: LocalDeveloperProject, request: Parameters<typeof readTrustedLocalGit>[1]) => {
    if (!project.gitSnapshotSource) throw denied();
    return readTrustedLocalGit(project.canonicalPath, request, { snapshotDirectory: options.gitSnapshotDirectory, source: project.gitSnapshotSource });
  };
  const previewRedactor = new SecretRedactor();
  const screenTranscript = (raw: string): string => {
    const known = options.redactor.redact(raw);
    // Diff prefixes and surrounding console text prevent document parsing.
    // Withhold the whole transcript when a credential field is present, rather
    // than attempt to reconstruct a potentially multiline secret fragment.
    const candidate = known.replace(/^[+ -]/gmu, '');
    if (screenLocalText(candidate, previewRedactor).masked) return '***REDACTED***';
    // Consume a delimiter before each complete field to avoid restarting a
    // credential-key search at every byte of a large unbroken output token.
    for (const field of candidate.matchAll(/(?:^|[^\w.-])([\w.-]+)["']?\s*[:=]/gmu)) {
      if (/(?:token|secret|password|passwd|credential|key|authorization|cookie|connection[_-]?string|^_?auths?$)/iu.test(field[1] ?? '')) return '***REDACTED***';
    }
    return known;
  };
  const outputCapture: CommandOutputCapturePort = {
    redactText: value => options.outputCapture.redactText(value),
    capture: input => options.outputCapture.capture({ ...input, stdout: screenTranscript(input.stdout), stderr: screenTranscript(input.stderr) }),
  };
  const guarded = <T>(repository: StoredRepository, operation: (project: LocalDeveloperProject) => Promise<T>) =>
    options.withRegisteredProject(repository, async project => {
      if (project.canonicalPath !== repository.localBasePath || !project.identity) throw denied();
      return operation(project);
    });
  const dispatcher = new LocalCommandDispatcher({
    tasks: options.tasks, repositories: options.repositories, workspaces: options.workspaces,
    commandRuns: options.commandRuns, audit: options.audit, locks: options.locks, ownsLease: options.ownsLease,
    prepare: async (taskId, repository) => guarded(repository, async project => {
      const head = await cleanHead(project, options.gitSnapshotDirectory);
      const task = options.tasks.get(taskId);
      if (!task || task.taskType !== 'LOCAL_COMMAND' || task.status !== 'PREPARING') throw denied();
      const created = await options.worktrees.create({ taskId, repo: repository, baseRef: head,
        branch: createTaskBranchName({ taskType: 'CHORE', displaySequence: task.seq, goal: task.goal }) });
      if (created.headSha !== head || await cleanHead(project, options.gitSnapshotDirectory) !== head) throw denied();
    }),
    execute: async request => {
      const authorization = options.commandAuthorization(request.taskId);
      if (authorization?.workspace !== request.cwd) throw denied();
      const runner = new CommandRunner({ policy: options.policy, approvals: options.approvals,
        commandRuns: options.commandRuns, outputCapture, homeDir: options.homeDir,
        spawner: new LinuxIsolatedProcessSpawner({ workspaceForTask: options.commandAuthorization, timeoutMs: request.timeoutMs }) });
      return runner.run({ taskId: request.taskId, cwd: request.cwd, category: 'DEVELOPMENT', executable: request.executable, args: request.args });
    },
  });
  return new LocalDeveloper({
    withProject: options.withProject, redactor: { redact: screenTranscript },
    git: {
      status: async project => {
        const result = await readGit(project, { operation: 'status' });
        const entries: { status: string; path: string }[] = [];
        const records = result.stdout.split('\0');
        for (let i = 0; i < records.length; i++) {
          const entry = records[i];if (!entry) continue;
          if (entry.length < 4 || entry[2] !== ' ') throw denied();
          entries.push({ status: entry.slice(0, 2), path: entry.slice(3) });
          if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) i++;
        }
        return { entries, truncated: result.partialCapture === true };
      },
      diff: async (project, input) => {
        const result = await readGit(project, { operation: 'diff', ...input });
        return { diff: result.stdout, truncated: result.partialCapture === true };
      },
      log: async (project, maxCount) => {
        const text = (await readGit(project, { operation: 'log', maxCount })).stdout;
        const fields = text.split('\0');const commits: { sha: string; subject: string }[] = [];
        for (let i = 0; i + 1 < fields.length; i += 2) {
          const sha = fields[i]?.trim(), subject = fields[i + 1];
          if (!sha || !/^[a-f0-9]{40}$/u.test(sha) || subject === undefined) throw denied();
          commits.push({ sha, subject });
        }
        return { commits, truncated: false };
      },
      inspectRepository: async project => {
        const identity = await readGit(project, { operation: 'identity' });
        const remote = await options.github.getRepository(identity.owner, identity.name);
        if (!Number.isSafeInteger(remote.id) || remote.id <= 0 ||
            remote.owner.toLowerCase() !== identity.owner.toLowerCase() || remote.name.toLowerCase() !== identity.name.toLowerCase()) throw denied();
        return { githubRepositoryId: remote.id, owner: remote.owner, name: remote.name, defaultBranch: remote.defaultBranch };
      },
    },
    repositories: {
      getById: id => options.repositories.getById(id),
      register: async input => {
        const inspection = await inspectProfile(input.localBasePath);
        const profile = new RepositoryProfiler().profile(inspection);
        if (!options.canRegister(input.githubRepositoryId)) throw denied();
        const stored = options.repositories.upsert({ ...input, ...profile });
        return { repositoryId: stored.githubRepositoryId };
      },
    },
    commands: { run: async input => {
      const repository = options.repositories.getById(input.repositoryId);
      if (!repository) throw denied();
      return guarded(repository, async project => { await cleanHead(project, options.gitSnapshotDirectory);return dispatcher.run(input); });
    } },
  });
}
