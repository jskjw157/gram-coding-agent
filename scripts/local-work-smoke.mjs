import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(join(tmpdir(), 'gram-local-work-smoke-'));
const cli = fileURLToPath(new URL('../packages/local-work/dist/cli.js', import.meta.url));
const job = {
  operations: [
    {
      op: 'write_text',
      path: 'answer.cjs',
      content: "require('node:fs').writeFileSync('answer.txt', String(6 * 7)); console.log('local-code-ok');",
    },
    { op: 'run_node', path: 'answer.cjs' },
    { op: 'read_text', path: 'answer.txt' },
  ],
};
function run(args, input) {
  return spawnSync(process.execPath, [cli, '--workspace', root, ...args], {
    input,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 1_048_576,
    env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, LANG: 'C.UTF-8' },
  });
}
try {
  const refused = run([], JSON.stringify(job));
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stderr).error, /trusted local code/);
  assert.equal(existsSync(join(root, 'answer.cjs')), false);
  const invalid = run([], '{invalid-json');
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).error, 'Invalid local job JSON');
  const completed = run(['--trusted-local-code'], JSON.stringify(job));
  assert.equal(completed.status, 0, completed.stderr);
  const result = JSON.parse(completed.stdout);
  assert.equal(result.executionIsolation, 'HOST_PROCESS_NOT_OS_SANDBOXED');
  assert.equal(result.results[1].stdout, 'local-code-ok\n');
  assert.equal(result.results[2].content, '42');
  assert.deepEqual(result.runs, [{ id: 1, status: 'SUCCEEDED', exitCode: 0 }]);
  console.log(
    JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      fileWrite: 'PASS',
      codeExecution: 'PASS',
      resultRead: 'PASS',
      defaultRefusal: 'PASS',
      invalidJson: 'PASS',
      executionIsolation: result.executionIsolation,
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
