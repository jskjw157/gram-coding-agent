import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Only the authored fixture is executed. No network, discovery, real credentials,
// profile files, Git helpers, or arbitrary path/command input are used.
const marker = 'GRAM_SECRET_BOUNDARY_PROBE=';
const stage = process.argv[2];
assert.ok(['direct', 'descendant-parent', 'descendant', 'npm-test'].includes(stage));

if (stage === 'descendant-parent') {
  // Inherit exactly the environment received from the real CommandRunner.
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), 'descendant'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 5_000,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(child.error, undefined, 'Descendant must launch normally');
  assert.equal(child.signal, null, 'Descendant must finish before its deadline');
  assert.equal(child.status, 0, 'Descendant must execute the probe, not fail to start');
  const lines = child.stdout.split('\n').filter((line) => line.startsWith(marker));
  assert.equal(lines.length, 1, 'Exactly one descendant handshake is required');
  const report = JSON.parse(lines[0].slice(marker.length));
  report.launcher = { pid: process.pid, uid: process.getuid(), euid: process.geteuid() };
  process.stdout.write(marker + JSON.stringify(report) + '\n');
} else {
  const manifest = JSON.parse(readFileSync('./secret-boundary-manifest.json', 'utf8'));
  assert.equal(manifest.schema, 'gram-secret-boundary-fixture/v1');
  assert.equal(path.dirname(manifest.root), '/tmp');
  assert.ok(path.basename(manifest.root).startsWith('gram-secret-boundary-'));
  assert.equal(process.cwd(), manifest.worktree);
  assert.ok(manifest.worktree.startsWith(manifest.root + path.sep));

  function fixturePath(relative) {
    const target = path.resolve(manifest.root, relative);
    assert.ok(target.startsWith(manifest.root + path.sep), 'Probe paths stay inside its disposable fixture');
    return target;
  }

  function readAttempt(relative, expectedDigest) {
    try {
      const bytes = readFileSync(fixturePath(relative));
      return {
        readSucceeded: true,
        canaryMatched: createHash('sha256').update(bytes).digest('hex') === expectedDigest,
        errorCode: null,
      };
    } catch (error) {
      return {
        readSucceeded: false,
        canaryMatched: false,
        errorCode: typeof error.code === 'string' ? error.code : 'UNKNOWN',
      };
    }
  }

  // Inspect names, never serialize values or the complete process environment.
  const environment = {
    GITHUB_TOKEN: Object.hasOwn(process.env, 'GITHUB_TOKEN'),
    GH_TOKEN: Object.hasOwn(process.env, 'GH_TOKEN'),
    CONTROL_PLANE_API_KEY: Object.hasOwn(process.env, 'CONTROL_PLANE_API_KEY'),
    GRAM_MCP_INTERNAL_SECRET: Object.hasOwn(process.env, 'GRAM_MCP_INTERNAL_SECRET'),
    OPENAI_ADMIN_KEY: Object.hasOwn(process.env, 'OPENAI_ADMIN_KEY'),
  };
  const reads = {};
  for (const credential of manifest.credentials) {
    reads[credential.label] = readAttempt(credential.relativePath, credential.digest);
  }
  const status = readFileSync('/proc/self/status', 'utf8');
  const capEff = /^CapEff:\s+([0-9a-f]+)$/m.exec(status)?.[1];
  assert.ok(capEff, 'Linux capability metadata is required');
  process.stdout.write(marker + JSON.stringify({
    schema: 'gram-secret-boundary-probe/v1',
    challenge: manifest.challenge,
    stage,
    pid: process.pid,
    ppid: process.ppid,
    uid: process.getuid(),
    euid: process.geteuid(),
    capEff,
    environment,
    reads,
    permissionControl: readAttempt(manifest.permissionControl, null),
    npmLifecycle: process.env.npm_lifecycle_event ?? null,
  }) + '\n');
}
