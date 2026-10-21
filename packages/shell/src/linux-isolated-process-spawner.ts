import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ProcessSpawner, SpawnRequest, SpawnResult } from './command-runner.js';
import { pinPackageEntrypoints, type PackageCliPin } from './package-cli-pins.js';
import { assertTrustedRuntime } from './sandbox-runtime-validation.js';
import { RUNTIME_ROOT } from './sandbox-runtime-contract.js';

export interface LinuxIsolatedProcessSpawnerOptions {
  workspaceForTask(taskId: string): { workspace: string; identity: string } | undefined;
  entryPath?: string;
  runtimeRoot?: string;
  timeoutMs?: number;
}

type ExecutablePin = PackageCliPin;
const DEFAULT_RUNTIME = RUNTIME_ROOT;

export class LinuxIsolatedProcessSpawner implements ProcessSpawner {
  private readonly timeoutMs: number;
  private readonly running = new Set<string>();
  constructor(protected readonly options: LinuxIsolatedProcessSpawnerOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 900_000) {
      throw new Error('Invalid isolated command deadline');
    }
  }

  // Only trusted composition supplies this registration resolver. Request category,
  // environment, executable and shell text never select a less restricted profile.
  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    if (this.running.has(request.taskId)) throw new Error('A task command is already executing');
    this.running.add(request.taskId);
    try { return await this.execute(request); }
    finally { this.running.delete(request.taskId); }
  }

  private async execute(request: SpawnRequest): Promise<SpawnResult> {
    const authorization = this.options.workspaceForTask(request.taskId);
    const workspace = authorization?.workspace;
    if (workspace === undefined || authorization?.identity === undefined || authorization.identity.length === 0 ||
        !isAbsolute(workspace) || workspace !== request.cwd) {
      throw new Error('Isolated execution requires the registered task workspace');
    }
    const authorizationIdentity = authorization.identity;
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
      throw new Error('Linux x86-64 Node 24 isolation is required');
    }
    if (realpathSync(workspace) !== workspace || workspace === '/' || workspace === '/tmp' ||
        !lstatSync(workspace).isDirectory()) {
      throw new Error('Isolated execution requires a canonical task workspace');
    }
    const entry = this.options.entryPath ?? '/usr/local/libexec/gram-sandbox-entry';
    assertRootOwnedExecutable(entry);
    assertRootOwnedExecutable('/usr/bin/bwrap');
    const runtime = dirname(dirname(realpathSync(process.execPath)));
    assertTrustedRuntime(this.options.runtimeRoot ?? DEFAULT_RUNTIME);
    if (runtime === '/' || workspace === runtime || runtime.startsWith(workspace + '/')) {
      throw new Error('The task workspace cannot contain its trusted runtime');
    }
    const directory = openSync(workspace, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const pins: ExecutablePin[] = [];
    let primaryError: unknown;
    let result: SpawnResult | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      pins.push(...pinWorktreeMetadata(workspace));
      pins.push(...pinPackageEntrypoints(workspace));
      const args = this.argumentsFor(workspace, runtime, entry, request, pins);
      const current = this.options.workspaceForTask(request.taskId);
      if (current?.workspace !== workspace || current.identity !== authorizationIdentity) {
        throw new Error('Isolated command authorization was lost');
      }
      result = await new Promise<SpawnResult>((accept, reject) => {
        const child = spawn('/usr/bin/bwrap', args, {
          cwd: '/', env: {}, shell: false, stdio: ['ignore', 'pipe', 'pipe', directory, ...pins.map((pin) => pin.descriptor)],
        });
        const output: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
        const sizes = { stdout: 0, stderr: 0 };
        let failure: Error | undefined;
        const fail = (reason: string): void => {
          if (failure !== undefined) return;
          failure = new Error(reason);
          output.stdout.length = 0; output.stderr.length = 0;
          // bwrap's namespace init dies with its monitor, killing every process
          // in that PID namespace, including detached descendants.
          child.kill('SIGKILL');
        };
        const deadline = setTimeout(() => fail('Isolated command deadline exceeded'), this.timeoutMs);
        const authorizationCheck = setInterval(() => {
          try {
            const current = this.options.workspaceForTask(request.taskId);
            if (current?.workspace !== workspace || current.identity !== authorizationIdentity) {
              fail('Isolated command authorization was lost');
            }
          } catch { fail('Isolated command authorization was lost'); }
        }, 50);
        for (const stream of ['stdout', 'stderr'] as const) {
          const pipe = child[stream];
          if (pipe === null) { fail('Isolated command capture is unavailable'); continue; }
          pipe.on('data', (chunk: Buffer) => {
            if (failure !== undefined) return;
            sizes[stream] += chunk.length;
            if (sizes[stream] > 8 * 1024 * 1024) { fail('Isolated command output limit exceeded'); return; }
            output[stream].push(chunk);
          });
        }
        child.once('error', () => fail('Isolated command setup failed'));
        child.once('close', (code) => {
          clearTimeout(deadline);
          clearInterval(authorizationCheck);
          if (failure !== undefined) { reject(failure); return; }
          if (code === null) { reject(new Error('Isolated command terminated')); return; }
          accept({ exitCode: code, stdout: Buffer.concat(output.stdout).toString('utf8'),
            stderr: Buffer.concat(output.stderr).toString('utf8') });
        });
      });
    } catch (error) {
      primaryError = error;
    } finally {
      for (const pin of pins) {
        try { closeSync(pin.descriptor); } catch (error) { cleanupErrors.push(error); }
        try { pin.cleanup?.(); } catch (error) { cleanupErrors.push(error); }
      }
      try { closeSync(directory); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors],
      'Isolated command cleanup failed', { cause: primaryError });
    if (primaryError !== undefined) throw primaryError;
    if (result === undefined) throw new Error('Isolated command did not produce a result');
    return result;
  }

  protected argumentsFor(workspace: string, runtime: string, entry: string, request: SpawnRequest,
    pins: readonly ExecutablePin[] = []): string[] {
    const args = [
      '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-net',
      '--unshare-uts', '--unshare-cgroup', '--disable-userns',
      '--uid', String(process.getuid?.()), '--gid', String(process.getgid?.()),
      '--cap-drop', 'ALL', '--die-with-parent', '--new-session', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
      '--ro-bind', '/lib', '/lib', '--ro-bind', '/lib64', '/lib64',
      '--ro-bind', this.options.runtimeRoot ?? DEFAULT_RUNTIME, runtime, '--ro-bind', entry, '/gram-sandbox-entry',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--tmpfs', '/home/gram-sandbox', '--dir', '/home/gram-sandbox/tmp', '--dir', '/run',
      '--bind-fd', '3', workspace,
    ];
    // WSL injects Windows-backed driver/library mounts below /usr. The public
    // Linux system tree must not implicitly expose that host bridge.
    if (existsSync('/usr/lib/wsl')) args.push('--tmpfs', '/usr/lib/wsl');
    pins.forEach((pin, index) => args.push('--ro-bind-fd', String(index + 4), pin.path));
    args.push('--chdir', workspace,
      '--setenv', 'PATH', join(runtime, 'bin') + ':/usr/bin:/bin',
      '--setenv', 'HOME', '/home/gram-sandbox', '--setenv', 'TMPDIR', '/home/gram-sandbox/tmp',
      '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'OPENSSL_CONF', '/dev/null',
      '--', '/gram-sandbox-entry', workspace, runtime);
    for (const pin of pins) if (pin.execute === true) args.push('--script', pin.path);
    args.push('--');
    if ('shellText' in request) {
      args.push(realpathSync('/bin/bash'), '--noprofile', '--norc', '-c', request.shellText);
    } else {
      const executable = request.executable.includes('/') ? request.executable
        : ['node', 'npm', 'npx', 'pnpm'].includes(request.executable)
          ? join(runtime, 'bin', request.executable) : join('/usr/bin', request.executable);
      args.push(realpathSync(executable), ...request.args);
    }
    return args;
  }
}

function pinWorktreeMetadata(workspace: string): ExecutablePin[] {
  const path = join(workspace, '.git');
  let descriptor: number;
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() ||
        realpathSync(`/proc/self/fd/${descriptor}`) !== path) {
      throw new Error('Task Git metadata requires a private regular worktree pointer');
    }
    return [{ path, descriptor }];
  } catch (error) { closeSync(descriptor); throw error; }
}

function assertRootOwnedExecutable(file: string): void {
  if (!isAbsolute(file) || resolve(file) !== file || realpathSync(file) !== file) {
    throw new Error('Isolation requires a canonical root-owned executable');
  }
  const binary = lstatSync(file);
  if (!binary.isFile() || binary.uid !== 0 || (binary.mode & 0o6022) !== 0 || (binary.mode & 0o111) === 0) {
    throw new Error('Isolation requires a root-owned non-setuid executable');
  }
  for (let parent = dirname(file); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new Error('Isolation executable ancestors must be root-owned and private to writers');
    }
    if (parent === '/') break;
  }
}
