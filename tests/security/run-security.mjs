import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';

assert.equal(process.platform, 'linux', 'Security acceptance requires Linux');
assert.equal(process.versions.node.split('.')[0], '24', 'Security acceptance requires Node 24');
assert.equal(process.argv.length, 2, 'No arbitrary filters or commands');
const root = mkdtempSync('/tmp/gram-security-suite-');
try {
  const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8',
    OPENSSL_CONF: '/dev/null', GRAM_SANDBOX_ENTRY: '/usr/local/libexec/gram-sandbox-entry' };
  for (const [executable, args] of [
    [process.execPath, ['tests/security/run-secret-boundary.mjs']],
    ['/usr/bin/python3', ['apps/execution-sandbox/test_boundary.py']],
    ['/usr/bin/python3', ['apps/execution-sandbox/test_build.py']],
    ['/usr/bin/python3', ['scripts/test_stage_sandbox_node.py']],
  ]) {
    const result = spawnSync(executable, args, { env, stdio: 'inherit', timeout: 120_000, killSignal: 'SIGKILL' });
    if (result.error || result.signal || result.status !== 0) {
      process.exitCode = result.status && result.status > 0 ? result.status : 1;
      break;
    }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
