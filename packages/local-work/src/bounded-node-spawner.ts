import { spawn } from 'node:child_process';
import type { ProcessSpawner, SpawnRequest, SpawnResult } from '@gram/shell';

/** Resource limits for trusted local code. This does not provide OS isolation. */
export class BoundedNodeSpawner implements ProcessSpawner {
  constructor(
    private readonly timeoutMs: number,
    private readonly maxOutputBytes: number,
    private readonly signal?: AbortSignal,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid deadline');
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 1_048_576)
      throw new Error('Invalid output limit');
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    if (this.signal?.aborted) throw new Error('Local execution cancelled');
    if (process.platform === 'win32') throw new Error('Local work requires a POSIX process group');
    // Policy sees the Node operation; this adapter pins its binary rather than
    // resolving a user-controlled PATH or accepting another executable.
    if ('shellText' in request || request.executable !== 'node')
      throw new Error('Only the current Node executable is supported');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      let failure: Error | undefined;
      let settled = false;
      const killGroup = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
            failure ??= new Error('Could not terminate local process group');
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', onAbort);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        failure ??= error;
        killGroup();
        // A descendant may have moved to a different process group while
        // retaining these pipes. Do not wait for its close to settle the call.
        child.stdout.destroy();
        child.stderr.destroy();
        cleanup();
        reject(failure);
      };
      const onAbort = () => fail(new Error('Local execution cancelled'));
      const timer = setTimeout(() => fail(new Error('Local code exceeded its deadline')), this.timeoutMs);
      this.signal?.addEventListener('abort', onAbort, { once: true });
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > this.maxOutputBytes) {
          fail(new Error('Local code exceeded its output limit'));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));
      child.once('error', () => {
        fail(new Error('Local Node process could not start'));
      });
      child.once('exit', () => {
        if (!settled) killGroup();
      });
      child.once('close', (code) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (failure !== undefined) reject(failure);
        else if (code === null) reject(new Error('Local Node process terminated by a signal'));
        else
          resolve({
            exitCode: code,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
      });
    });
  }
}
