import { spawn } from 'node:child_process';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

/** INTERNAL: trustedHelper must be independently provisioned and verified, not
 * selected from the release currently being inspected. No CLI/MCP path accepts
 * this value. Tests use a freshly compiled temporary helper, not a deployment.
 * The child receives only the already-open descriptor as fd 3, never a path or
 * file contents. No raw child output, exceptions or ACL entries leave this API.
 */
export async function checkMacAcl(file: FileHandle, trustedHelper: string): Promise<boolean> {
  try {
    if (process.platform !== 'darwin' || !Number.isInteger(file.fd) || file.fd < 0 || !isAbsolute(trustedHelper)
      || [...trustedHelper].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) return false;
    const before = await file.stat({ bigint: true });
    const output = await new Promise<string | null>(resolve => {
      const child = spawn(trustedHelper, [], { shell: false, env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' },
        stdio: ['ignore', 'pipe', 'pipe', file.fd] });
      let done = false; let size = 0; const chunks: Buffer[] = [];
      const finish = (result: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(result); } };
      const abort = () => { child.kill('SIGKILL'); finish(null); };
      const timer = setTimeout(abort, 2000);
      child.stdout?.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 4096) abort(); else if (!done) chunks.push(Buffer.from(chunk));
      });
      child.stderr?.on('data', abort);
      child.on('error', () => finish(null));
      child.on('close', (code, signal) => finish(code === 0 && signal === null ? Buffer.concat(chunks).toString('utf8') : null));
    });
    if (output === null) return false;
    const value: unknown = JSON.parse(output);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const result = value as Record<string, unknown>;
    if (Object.keys(result).length !== 4 || result.schemaVersion !== 1 || result.safe !== true
      || result.dev !== before.dev.toString() || result.ino !== before.ino.toString()) return false;
    const after = await file.stat({ bigint: true });
    return after.dev === before.dev && after.ino === before.ino && after.mode === before.mode
      && after.uid === before.uid && after.gid === before.gid && after.nlink === before.nlink
      && after.size === before.size && after.ctimeNs === before.ctimeNs && after.mtimeNs === before.mtimeNs;
  } catch { return false; }
}
