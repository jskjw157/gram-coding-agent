import type {
  LocalDeveloperToolsPort, LocalDeveloperRunInputValue, LocalDeveloperRunView, LocalGitDiffInputValue,
  LocalGitDiffView, LocalGitLogInputValue, LocalGitLogView, LocalGitStatusView, LocalRepositoryInputValue,
} from '@gram/mcp';

export interface LocalDeveloperProject { canonicalPath: string; identity: string }
export interface LocalRepositoryMetadata { githubRepositoryId: number; owner: string; name: string; defaultBranch: string }
export interface LocalDeveloperOptions {
  /** Must pin/revalidate the configured root and reject controller-private paths for the whole callback. */
  withProject<T>(input: LocalRepositoryInputValue, operation: (project: LocalDeveloperProject) => Promise<T>): Promise<T>;
  /** Trusted fixed Git reads: disable hooks/config helpers, ext-diff/textconv, optional locks; bound all capture. */
  git: {
    status(project: LocalDeveloperProject): Promise<LocalGitStatusView>;
    diff(project: LocalDeveloperProject, input: { staged: boolean; relativePath?: string }): Promise<LocalGitDiffView>;
    log(project: LocalDeveloperProject, maxCount: number): Promise<LocalGitLogView>;
    inspectRepository(project: LocalDeveloperProject): Promise<LocalRepositoryMetadata>;
  };
  repositories: {
    register(input: LocalRepositoryMetadata & { localBasePath: string }): Promise<{ repositoryId: number }>;
    getById(id: number): { commands: Partial<Record<LocalDeveloperRunInputValue['command'], string>> } | undefined;
  };
  /** Owns persisted task/workspace, RepoLock lease, policy, ordinary execution authorization and isolated runner.
   * Must recheck declaration under lease and return real persisted command evidence; never marks checks/publication complete. */
  commands: { run(input: LocalDeveloperRunInputValue): Promise<LocalDeveloperRunView> };
  redactor: { redact(value: string): string };
}
const MAX_TEXT = 32000;
const denied = () => new Error('Local developer operation denied or failed');
function relative(value: string): boolean {
  return value === '.' || (value.length > 0 && value.length <= 2048 && !/[\\:]/u.test(value) &&
    !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' && !part.startsWith('-')));
}
function target(input: LocalRepositoryInputValue): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(input.root) || !relative(input.path)) throw denied();
}
export class LocalDeveloper implements LocalDeveloperToolsPort {
  constructor(private readonly options: LocalDeveloperOptions) {}
  private text(value: string): string { return this.options.redactor.redact(value).slice(0, MAX_TEXT); }
  async register(input: LocalRepositoryInputValue): Promise<{ repositoryId: number }> {
    target(input);
    return this.options.withProject(input, async project => {
      const metadata = await this.options.git.inspectRepository(project);
      if (!Number.isSafeInteger(metadata.githubRepositoryId) || metadata.githubRepositoryId <= 0 ||
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(metadata.owner) ||
          !/^[A-Za-z0-9_.-]{1,100}$/u.test(metadata.name) || ['.', '..'].includes(metadata.name) ||
          !metadata.defaultBranch || metadata.defaultBranch.startsWith('-') || /[\s~^:?*[\\]/u.test(metadata.defaultBranch) ||
          Array.from(metadata.defaultBranch).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
          metadata.defaultBranch.includes('..') || metadata.defaultBranch.includes('@{')) throw denied();
      return this.options.repositories.register({ ...metadata, localBasePath: project.canonicalPath });
    });
  }
  async status(input: LocalRepositoryInputValue): Promise<LocalGitStatusView> {
    target(input);
    return this.options.withProject(input, async project => {
      const result = await this.options.git.status(project);
      return { entries: result.entries.slice(0, 200).map(entry => ({ path: this.text(entry.path), status: this.text(entry.status).slice(0, 2) })), truncated: result.truncated || result.entries.length > 200 };
    });
  }
  async diff(input: LocalGitDiffInputValue): Promise<LocalGitDiffView> {
    target(input); if (typeof input.staged !== 'boolean' || (input.relativePath !== undefined && !relative(input.relativePath))) throw denied();
    return this.options.withProject(input, async project => {
      const result = await this.options.git.diff(project, { staged: input.staged, ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }) });
      return { diff: this.text(result.diff), truncated: result.truncated || result.diff.length > MAX_TEXT };
    });
  }
  async log(input: LocalGitLogInputValue): Promise<LocalGitLogView> {
    target(input); if (!Number.isSafeInteger(input.maxCount) || input.maxCount < 1 || input.maxCount > 100) throw denied();
    return this.options.withProject(input, async project => {
      const result = await this.options.git.log(project, input.maxCount);
      return { commits: result.commits.slice(0, input.maxCount).map(commit => {
        if (!/^[a-f0-9]{40}$/u.test(commit.sha)) throw denied();
        return { sha: commit.sha, subject: this.text(commit.subject).slice(0, 240) };
      }), truncated: result.truncated || result.commits.length > input.maxCount };
    });
  }
  async run(input: LocalDeveloperRunInputValue): Promise<LocalDeveloperRunView> {
    if (!Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0 || !['lint', 'test', 'build', 'dev'].includes(input.command) ||
        !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 900000) throw denied();
    const repository = this.options.repositories.getById(input.repositoryId);
    if (!repository?.commands[input.command]) throw denied();
    const result = await this.options.commands.run({ repositoryId: input.repositoryId, command: input.command, timeoutMs: input.timeoutMs });
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(result.taskId) ||
        !Number.isSafeInteger(result.commandRunId) || result.commandRunId <= 0 || !Number.isSafeInteger(result.exitCode) ||
        result.status !== (result.exitCode === 0 ? 'SUCCEEDED' : 'FAILED')) throw denied();
    return { taskId: result.taskId, commandRunId: result.commandRunId, status: result.status, exitCode: result.exitCode,
      stdout: this.text(result.stdout), stderr: this.text(result.stderr), truncated: result.truncated || result.stdout.length > MAX_TEXT || result.stderr.length > MAX_TEXT };
  }
}

