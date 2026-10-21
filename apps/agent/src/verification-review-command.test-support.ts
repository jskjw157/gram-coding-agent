import { spawn } from 'node:child_process';
import type { ProcessSpawner, SpawnRequest, SpawnResult } from '@gram/shell';
import { REVIEW_MAX_BYTES } from './verification-review-command.js';

interface BoundedReadOptions { timeoutMs?: number; maxOutputBytes?: number }

/** Test fixtures only. Production must inject its guarded Git process port. */
export class BoundedReviewSpawner implements ProcessSpawner {
  private readonly limit: number;
  private readonly timeoutMs: number;
  constructor(options: BoundedReadOptions) {
    this.limit = options.maxOutputBytes ?? REVIEW_MAX_BYTES;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.limit) || this.limit <= 0 || this.limit > REVIEW_MAX_BYTES ||
        !Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid review command bounds');
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    if ('shellText' in request) throw new Error('Review shell execution is forbidden');
    return new Promise((resolve, reject) => {
      const child = spawn('git', [...request.args], {
        cwd: request.cwd, env: { ...request.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', GIT_NO_REPLACE_OBJECTS: '1', LC_ALL: 'C' },
        shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      let failure: Error | undefined;
      const fail = (reason: string): void => {
        if (failure !== undefined) return;
        failure = new Error(reason);
        chunks.stdout.length = 0; chunks.stderr.length = 0;
        child.kill('SIGKILL');
      };
      const timeout = setTimeout(() => fail('Review command timed out'), this.timeoutMs);
      for (const stream of ['stdout', 'stderr'] as const) {
        child[stream].on('data', (chunk: Buffer) => {
          if (failure !== undefined) return;
          sizes[stream] += chunk.length;
          if (sizes[stream] > this.limit) { fail('Review command output exceeded the byte bound'); return; }
          chunks[stream].push(chunk);
        });
      }
      child.once('error', () => fail('Review command process failed'));
      // Rejection waits for close: no timed-out/overflowing child continues after the caller resumes.
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (failure !== undefined) { reject(failure); return; }
        if (code === null) { reject(new Error('Review command terminated without an exit code')); return; }
        try {
          const decode = (stream: 'stdout' | 'stderr'): string =>
            new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks[stream], sizes[stream]));
          resolve({ exitCode: code, stdout: decode('stdout'), stderr: decode('stderr') });
        } catch { reject(new Error('Review command output is not valid UTF-8')); }
      });
    });
  }
}

