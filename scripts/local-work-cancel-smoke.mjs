import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/local-work/dist/cli.js', import.meta.url));
for (const signal of ['SIGINT', 'SIGTERM']) {
  const root = mkdtempSync(join(tmpdir(), 'gram-cancel-smoke-'));
  let child;
  let scriptPid;
  try {
    child = spawn(process.execPath, [cli, '--workspace', root, '--trusted-local-code'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C.UTF-8' },
    });
    let stderr = '';
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    const closed = once(child, 'close');
    child.stdin.end(
      JSON.stringify({
        operations: [
          {
            op: 'write_text',
            path: 'wait.cjs',
            content: "require('node:fs').writeFileSync('pid.txt', String(process.pid)); setInterval(() => {},100);",
          },
          { op: 'run_node', path: 'wait.cjs' },
        ],
      }),
    );
    const startupDeadline = Date.now() + 5_000;
    while (!existsSync(join(root, 'pid.txt')) && Date.now() < startupDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(existsSync(join(root, 'pid.txt')), true, 'Synthetic script did not start');
    scriptPid = Number(readFileSync(join(root, 'pid.txt'), 'utf8'));
    assert.equal(Number.isSafeInteger(scriptPid) && scriptPid > 1, true);
    child.kill(signal);
    let timer;
    const result = await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CLI cancellation exceeded 2 seconds')), 2_000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result[0], signal === 'SIGINT' ? 130 : 143);
    assert.match(JSON.parse(stderr).error, /cancelled/);
    const exitDeadline = Date.now() + 2_000;
    let exited = false;
    while (Date.now() < exitDeadline) {
      try {
        process.kill(scriptPid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') {
          exited = true;
          break;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(exited, true, 'Synthetic script remained alive after CLI cancellation');
    console.log(JSON.stringify({ signal, cliExit: result[0], processCleanup: 'PASS' }));
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) child.kill('SIGKILL');
    if (scriptPid !== undefined) {
      try {
        process.kill(-scriptPid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}
