import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { NativeWorkspaceRequest, NativeWorkspaceTransport } from './windows-workspace-client.js';
import { NativeWorkspaceDeniedError, NativeWorkspaceUnresolvedError, parseNativeWorkspaceReply, validateNativeWorkspaceOperation } from './windows-workspace-client.js';

const deny = () => {
  const error = new NativeWorkspaceDeniedError();
  error.message = 'Native workspace transport denied or failed';
  return error;
};
const INPUT_LIMIT = 3 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;
const READ_LIMITS = { stat: 16, read: 2, readGitChunk: 8, list: 1 } as const;
interface QueuedRead { request: NativeWorkspaceRequest; key: string; resolve(value: unknown): void; reject(error: unknown): void }
interface ReadBatchRequest { operation: 'readBatch'; root: string; path: '.'; protectedPaths: readonly string[]; protectedMutationPaths?: readonly string[]; projectPath?: string; expectedProjectIdentity?: string; items: Record<string, unknown>[] }


/** A trusted install supplies an exact helper digest. There is no caller-selected
 * executable/argument/environment/shell field. Production must additionally
 * protect the installed helper and its ancestors from workspace mutations. */
export class FixedWindowsWorkspaceTransport implements NativeWorkspaceTransport {
  private readonly helperPath: string;
  private readonly expectedSha256: string;
  private readonly queued: QueuedRead[] = [];
  private outstanding = 0;
  private activeFrames = 0;
  private scheduled = false;
  constructor(options: { helperPath: string; expectedSha256: string }) {
    if (!isAbsolute(options.helperPath) || !options.helperPath.endsWith('.exe') ||
        !/^[a-f0-9]{64}$/u.test(options.expectedSha256)) throw deny();
    this.helperPath = options.helperPath;this.expectedSha256 = options.expectedSha256;
  }

  private async assertHelper(): Promise<void> {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(this.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n ||
          await realpath(this.helperPath) !== this.helperPath) throw deny();
      const digest = createHash('sha256').update(await file.readFile()).digest('hex');
      const after = await file.stat({ bigint: true });
      if (digest !== this.expectedSha256 || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw deny();
    } finally { await file?.close(); }
  }

  async run(request: NativeWorkspaceRequest): Promise<unknown> {
    if (!Object.hasOwn(READ_LIMITS, request.operation)) return this.execute(request);
    if (this.outstanding >= 256) throw deny();
    const copy = structuredClone(request);
    const allowed = ['operation', 'root', 'path', 'protectedPaths', 'protectedMutationPaths', 'projectPath', 'expectedProjectIdentity', ...(copy.operation === 'readGitChunk' ? ['offset', 'length'] : [])];
    if (Object.keys(copy).some(key => !allowed.includes(key))) throw deny();
    validateNativeWorkspaceOperation({ operation: copy.operation, path: copy.path,
      ...(copy.operation === 'readGitChunk' ? { offset: copy.offset, length: copy.length } : {}) } as Parameters<typeof validateNativeWorkspaceOperation>[0]);
    const key = JSON.stringify([copy.operation, copy.root, copy.protectedPaths, Object.hasOwn(copy, 'protectedMutationPaths'), copy.protectedMutationPaths, Object.hasOwn(copy, 'projectPath'), copy.projectPath, Object.hasOwn(copy, 'expectedProjectIdentity'), copy.expectedProjectIdentity]);
    this.outstanding++;
    return new Promise((resolve, reject) => {this.queued.push({ request: copy, key, resolve, reject });this.schedule();});
  }

  private schedule(): void {
    if (this.scheduled || this.queued.length === 0 || this.activeFrames >= 4) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      while (this.queued.length > 0 && this.activeFrames < 4) {
        const first = this.queued.shift();if (!first) break;
        const batch = [first];const limit = READ_LIMITS[first.request.operation as keyof typeof READ_LIMITS];
        for (let i = 0; i < this.queued.length && batch.length < limit;) {
          if (this.queued[i]?.key === first.key) batch.push(...this.queued.splice(i, 1));else i++;
        }
        this.activeFrames++;
        void this.dispatch(batch).finally(() => {this.activeFrames--;this.outstanding -= batch.length;this.schedule();});
      }
    });
  }

  private async dispatch(batch: QueuedRead[]): Promise<void> {
    try {
      const first = batch[0];if (!first) throw deny();
      if (batch.length === 1) {first.resolve(await this.execute(first.request));return;}
      const request = first.request;
      const frame: ReadBatchRequest = { operation: 'readBatch', root: request.root, path: '.', protectedPaths: request.protectedPaths,
        ...(Object.hasOwn(request, 'protectedMutationPaths') ? { protectedMutationPaths: request.protectedMutationPaths } : {}),
        ...(Object.hasOwn(request, 'projectPath') ? { projectPath: request.projectPath } : {}),
        ...(Object.hasOwn(request, 'expectedProjectIdentity') ? { expectedProjectIdentity: request.expectedProjectIdentity } : {}),
        items: batch.map(({ request: item }) => ({ operation: item.operation, path: item.path,
          ...(item.operation === 'readGitChunk' ? { offset: item.offset, length: item.length } : {}) })),
      };
      const reply = await this.execute(frame);
      if (!reply || typeof reply !== 'object' || Array.isArray(reply) || Object.keys(reply).sort().join() !== 'ok,results' ||
          !('ok' in reply) || reply.ok !== true || !('results' in reply) || !Array.isArray(reply.results) || reply.results.length !== batch.length) throw deny();
      // Validate every item before settling any caller; the backend still checks its pinned root identity.
      const replies = reply.results;
      const results = batch.map((item, i) => parseNativeWorkspaceReply(replies[i], item.request.operation));
      batch.forEach((item, i) => item.resolve(results[i]));
    } catch {for (const item of batch) item.reject(deny());}
  }

  private async execute(request: NativeWorkspaceRequest | ReadBatchRequest): Promise<unknown> {
    try {
      await this.assertHelper();
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > INPUT_LIMIT) throw deny();
      return await new Promise<unknown>((resolve, reject) => {
        const child = spawn(this.helperPath, [], { cwd: '/', env: {}, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
        let size = 0;let failed = false;const chunks: Buffer[] = [];
        const fail = () => { failed = true;chunks.length = 0;if (child.pid !== undefined) child.kill('SIGKILL'); };
        const timer = setTimeout(fail, 6000);
        child.stdout.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > OUTPUT_LIMIT) fail();
          else if (!failed) chunks.push(chunk);
        });
        // Never persist or forward native diagnostics. The fixed worker reports
        // structured, content-free failures on stdout only.
        child.stderr.on('data', fail);
        child.stdin.on('error', fail);
        child.on('error', fail);
        child.on('close', code => {
          clearTimeout(timer);
          const finish = () => {
            if (failed || code !== 0) {
              if (!failed && code === 1) {
                try {
                  const receipt: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
                  if (receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt) &&
                      Object.keys(receipt).length === 2 && 'ok' in receipt && receipt.ok === false &&
                      'code' in receipt && receipt.code === 'DENIED_NO_CHANGE') {reject(deny());return;}
                } catch { /* Missing native rollback evidence remains unresolved. */ }
              }
              reject(child.pid !== undefined && ['write', 'move', 'mkdir', 'trash', 'restore'].includes(request.operation)
                ? new NativeWorkspaceUnresolvedError() : deny());return;
            }
            try {resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown);}
            catch {reject(['write', 'move', 'mkdir', 'trash', 'restore'].includes(request.operation) ? new NativeWorkspaceUnresolvedError() : deny());}
          };
          // A watchdog is a mitigation, not proof of native termination. Failed
          // mutations stay unresolved in the controller journal; elapsed time
          // never authorizes a retry or another mutation against that root.
          finish();
        });
        child.stdin.end(input);
      });
    } catch (error) {
      if (error instanceof NativeWorkspaceUnresolvedError) throw error;
      throw deny();
    }
  }
}
