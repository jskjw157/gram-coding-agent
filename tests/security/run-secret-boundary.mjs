import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath, URL } from 'node:url';

// PREPARATORY DRAFT #119. Run this entry point so neither a host environment nor
// an unbounded npm/process startup can invalidate the fake-only experiment.
// Usage: node tests/security/run-secret-boundary.mjs
// Expected M2 result: exit 1, 3 environment PASS + 3 file-isolation RED.
assert.equal(process.platform, 'linux', 'Linux is required');
assert.equal(process.versions.node.split('.')[0], '24', 'Use the repository Node 24 runtime');
assert.equal(process.argv.length, 2, 'This dedicated runner accepts no arbitrary commands or filters');
const require = createRequire(import.meta.url);
const vitestPackageFile = require.resolve('vitest/package.json');
const vitestPackage = JSON.parse(readFileSync(vitestPackageFile, 'utf8'));
const vitestCli = path.resolve(path.dirname(vitestPackageFile), vitestPackage.bin.vitest);
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const root = mkdtempSync('/tmp/gram-secret-boundary-run-');
let child;
let deadline;
let timedOut = false;
let interrupted = false;

function killOwnedProcessGroup() {
  if (child?.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function interrupt() {
  interrupted = true;
  killOwnedProcessGroup();
}

try {
  const home = path.join(root, 'home');
  mkdirSync(home, { mode: 0o700 });
  const fakeParentEnvironment = {
    GITHUB_TOKEN: 'fake-only-parent-github-' + randomUUID(),
    GH_TOKEN: 'fake-only-parent-gh-' + randomUUID(),
    CONTROL_PLANE_API_KEY: 'fake-only-parent-tunnel-' + randomUUID(),
    GRAM_MCP_INTERNAL_SECRET: 'fake-only-parent-mcp-' + randomUUID(),
    OPENAI_ADMIN_KEY: 'fake-only-parent-admin-' + randomUUID(),
  };
  child = spawn(process.execPath, [
    vitestCli, 'run',
    '--config', 'tests/security/vitest.secret-boundary.config.ts',
    '--configLoader', 'runner',
    '--reporter', 'verbose',
    '--no-color',
  ], {
    cwd: repoRoot,
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
    // Never read/spread the host environment. Parent canaries also detect a
    // spawner regression that omits env and silently inherits its own process.env.
    env: {
      PATH: path.dirname(process.execPath) + ':/usr/bin:/bin',
      HOME: home,
      TMPDIR: home,
      TMP: home,
      TEMP: home,
      LANG: 'C.UTF-8',
      GRAM_SECRET_BOUNDARY_RUN_ROOT: root,
      ...fakeParentEnvironment,
    },
  });
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  deadline = setTimeout(() => {
    timedOut = true;
    killOwnedProcessGroup();
  }, 45_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (timedOut) {
    process.stderr.write('HARNESS_TIMEOUT: owned test process group exceeded 45 seconds\n');
    process.exitCode = 124;
  } else if (interrupted || result.signal !== null) {
    process.stderr.write('HARNESS_INTERRUPTED: no security acceptance result\n');
    process.exitCode = 130;
  } else {
    process.exitCode = result.code ?? 1;
  }
} finally {
  clearTimeout(deadline);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
  try {
    // Also fence any remaining descendants after a premature test-runner exit.
    killOwnedProcessGroup();
  } finally {
    // All test cases are created beneath this exact mkdtemp root, never a glob.
    rmSync(root, { recursive: true, force: true });
  }
}
