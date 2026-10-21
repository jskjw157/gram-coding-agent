import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { NativeWorkspaceRequest, NativeWorkspaceTransport } from './windows-workspace-client.js';

const deny = () => new Error('Native workspace transport denied or failed');
const INPUT_LIMIT = 3 * 1024 * 1024;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

/** A trusted install supplies an exact helper digest. There is no caller-selected
 * executable/argument/environment/shell field. Production must additionally
 * protect the installed helper and its ancestors from workspace mutations. */
export class FixedWindowsWorkspaceTransport implements NativeWorkspaceTransport {
  private readonly helperPath: string;
  private readonly expectedSha256: string;
  constructor(options: { helperPath: string; expectedSha256: string }) {
    if (!isAbsolute(options.helperPath) || !options.helperPath.endsWith('.exe') ||
        !/^[a-f0-9]{64}$/u.test(options.expectedSha256)) throw deny();
    this.helperPath = options.helperPath;this.expectedSha256 = options.expectedSha256;
  }

  private assertHelper(): void {
    let fd: number | undefined;
    try {
      fd = openSync(this.helperPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size > 16n * 1024n * 1024n ||
          realpathSync(this.helperPath) !== this.helperPath) throw deny();
      const digest = createHash('sha256').update(readFileSync(fd)).digest('hex');
      const after = fstatSync(fd, { bigint: true });
      if (digest !== this.expectedSha256 || before.dev !== after.dev || before.ino !== after.ino ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw deny();
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  async run(request: NativeWorkspaceRequest): Promise<unknown> {
    try {
      this.assertHelper();
      const input = JSON.stringify(request);
      if (Buffer.byteLength(input) > INPUT_LIMIT) throw deny();
      return await new Promise<unknown>((resolve, reject) => {
        const began = Date.now();
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
            if (failed || code !== 0) {reject(deny());return;}
            try {resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown);}
            catch {reject(deny());}
          };
          // The native worker has its own fixed five-second watchdog. If the
          // WSL relay was killed, wait beyond that deadline before reporting.
          if (failed) setTimeout(finish, Math.max(0, 6500 - (Date.now() - began)));
          else finish();
        });
        child.stdin.end(input);
      });
    } catch { throw deny(); }
  }
}
