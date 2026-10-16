import { lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { createTaskId } from '@gram/domain';
import { FileService, WorkspacePathGuard } from '@gram/filesystem';
import { PolicyEngine } from '@gram/policy';
import { SecretRedactor } from '@gram/secrets';
import { CommandRunner } from '@gram/shell';
import { BoundedNodeSpawner } from './bounded-node-spawner.js';

export interface LocalWorkOptions {
  workspace: string;
  trustedLocalCode?: boolean;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}
export interface LocalRunEvidence {
  id: number;
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  exitCode: number | null;
}

/** Explicitly selected, trusted local workspace. NOT an arbitrary-code sandbox. */
export class LocalWorkSession {
  readonly taskId = createTaskId();
  private readonly root: string;
  private readonly rootIdentity: { dev: number; ino: number };
  private readonly guard: WorkspacePathGuard;
  private readonly files: FileService;
  private readonly runner: CommandRunner;
  private readonly runs: LocalRunEvidence[] = [];

  constructor(private readonly options: LocalWorkOptions) {
    this.root = realpathSync(options.workspace);
    const identity = lstatSync(this.root);
    if (!identity.isDirectory()) throw new Error('Workspace must be an existing directory');
    this.rootIdentity = { dev: identity.dev, ino: identity.ino };
    this.guard = new WorkspacePathGuard({
      getByTaskId: (taskId) => (taskId === this.taskId ? { linuxPath: this.root } : undefined),
    });
    this.files = new FileService(this.guard);
    const redactor = new SecretRedactor();
    this.runner = new CommandRunner({
      policy: new PolicyEngine(),
      approvals: { consume: async () => false },
      spawner: new BoundedNodeSpawner(options.timeoutMs ?? 5_000, options.maxOutputBytes ?? 65_536, options.signal),
      environment: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: this.root,
        TMPDIR: this.root,
        LANG: 'C.UTF-8',
      },
      commandRuns: {
        start: () => {
          const id = this.runs.length + 1;
          this.runs.push({ id, status: 'RUNNING', exitCode: null });
          return id;
        },
        finish: (id, result) => {
          const run = this.runs[id - 1];
          if (run === undefined) throw new Error('Unknown local command run');
          run.status = result.status;
          run.exitCode = result.exitCode;
        },
      },
      outputCapture: {
        redactText: (text) => redactor.redact(text),
        capture: async ({ commandRunId, stdout, stderr }) => ({
          stdout: redactor.redact(stdout),
          stderr: redactor.redact(stderr),
          stdoutPath: `memory://commands/${commandRunId}/stdout`,
          stderrPath: `memory://commands/${commandRunId}/stderr`,
        }),
      },
    });
  }

  private assertWorkspace(): void {
    const current = lstatSync(this.root);
    if (!current.isDirectory() || current.dev !== this.rootIdentity.dev || current.ino !== this.rootIdentity.ino)
      throw new Error('Workspace identity changed');
  }

  readText(relativePath: string): string {
    this.assertWorkspace();
    const info = statSync(this.guard.resolveExisting(this.taskId, relativePath));
    if (!info.isFile() || info.size > 1_048_576) throw new Error('Read requires a regular file of at most 1 MiB');
    return this.files.readTextStrict(this.taskId, relativePath);
  }

  writeText(relativePath: string, content: string): void {
    this.assertWorkspace();
    if (Buffer.byteLength(content) > 1_048_576) throw new Error('Write exceeds 1 MiB');
    this.files.writeText(this.taskId, relativePath, content);
  }

  async runNode(
    relativeScript: string,
    args: readonly string[] = [],
  ): Promise<{ commandRunId: number; exitCode: number; stdout: string; stderr: string }> {
    if (this.options.trustedLocalCode !== true)
      throw new Error('Execution requires explicit trusted local code opt-in');
    this.assertWorkspace();
    const script = this.guard.resolveExisting(this.taskId, relativeScript);
    if (!statSync(script).isFile() || !['.js', '.mjs', '.cjs'].includes(extname(script)))
      throw new Error('Expected a local Node script');
    if (args.length > 100 || args.some((arg) => arg.includes('\0') || arg.length > 16_384))
      throw new Error('Invalid script arguments');
    const result = await this.runner.run({
      taskId: this.taskId,
      cwd: this.root,
      category: 'DEVELOPMENT',
      executable: 'node',
      args: [script, ...args],
    });
    return {
      commandRunId: result.commandRunId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  history(): LocalRunEvidence[] {
    return this.runs.map((run) => ({ ...run }));
  }
}
