import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-assembly-contract-'));
  const mac = join(root, 'platform/macos');
  mkdirSync(join(mac, 'native'), { recursive: true });
  for (const name of ['assemble-core-release.sh', 'seal-core-release.mjs', 'package-release.mjs']) {
    cpSync(new URL(name, import.meta.url), join(mac, name));
  }
  for (const name of ['file-acl.c', 'peer-owner.c']) writeFileSync(join(mac, 'native', name), 'int main(void) { return 0; }\n');
  mkdirSync(join(root, 'packages/macos-lifecycle/dist'), { recursive: true });
  for (const name of ['supervisor-cli.js', 'operator-cli.js']) {
    writeFileSync(join(root, 'packages/macos-lifecycle/dist', name), '// synthetic entry\n');
  }
  const lock = 'lockfileVersion: 9.0\n# reviewed fixture lock\n';
  writeFileSync(join(root, 'pnpm-lock.yaml'), lock);
  const bin = join(root, 'fixture-bin'); mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  writeFileSync(join(bin, 'pnpm'), [
    '#!/bin/bash', 'set -euo pipefail',
    'if [[ "$1" == build ]]; then exit 0; fi',
    // The legacy resolver deliberately represents newer registry metadata.
    'legacy=0',
    'if [[ "${npm_config_force_legacy_deploy:-}" == true && " $* " != *" --config.force-legacy-deploy=false "* ]]; then legacy=1; fi',
    'if [[ "${npm_config_shared_workspace_lockfile:-}" == false && " $* " != *" --config.shared-workspace-lockfile=true "* ]]; then legacy=1; fi',
    'if [[ " $* " == *" --legacy "* || "$legacy" == 1 || "${MUTATE_LOCK:-}" == 1 ]]; then',
    '  printf "# unreviewed dependency resolution\\n" >> pnpm-lock.yaml',
    'fi',
    'out="${!#}"', 'mkdir -p "$out/dist"',
    'printf "// synthetic app entry\\n" > "$out/dist/main.js"',
  ].join('\n') + '\n', { mode: 0o755 });
  execFileSync('/usr/bin/git', ['init', '-q', root]);
  execFileSync('/usr/bin/git', ['-C', root, 'add', '.']);
  execFileSync('/usr/bin/git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, mac, bin, lock };
}

function assemble(f, mutate = false) {
  return spawnSync('/bin/bash', [join(f.mac, 'assemble-core-release.sh'), 'fixture-locked', join(f.root, 'output')], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: `${f.bin}:/usr/bin:/bin`, MUTATE_LOCK: mutate ? '1' : '0',
      npm_config_force_legacy_deploy: 'true', npm_config_shared_workspace_lockfile: 'false' },
  });
}

test('assembly preserves reviewed lock bytes through deployment', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  const f = fixture();
  try {
    const result = assemble(f);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.root, 'pnpm-lock.yaml'), 'utf8'), f.lock);
    const manifest = JSON.parse(readFileSync(join(f.root, 'output/release.json'), 'utf8'));
    assert.equal(manifest.lockDigest, createHash('sha256').update(f.lock).digest('hex'));
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('assembly refuses source lock mutation before sealing', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, () => {
  const f = fixture();
  try {
    const result = assemble(f, true);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /SOURCE_LOCK_CHANGED/u);
    assert.equal(existsSync(join(f.root, 'output')), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
