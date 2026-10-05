#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = '/Library/Application Support/HAAR/GramAgent';
const CONFIG_DIR = join(ROOT, 'config');
const TARGET = join(CONFIG_DIR, 'candidate-service.json');
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;

function fail(code) {
  process.stderr.write(`${code}\n`);
  process.exitCode = 2;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return fail('UNSUPPORTED_HOST');
  if ((process.geteuid?.() ?? process.getuid?.() ?? -1) !== 0) return fail('NOT_AUTHORIZED');
  const releaseId = option('--release-id');
  const replace = process.argv.includes('--replace');
  if (!releaseId || !ID.test(releaseId)) return fail('INVALID_RELEASE_ID');
  const allowed = new Set(['--release-id', releaseId, ...(replace ? ['--replace'] : [])]);
  if (process.argv.slice(2).some(arg => !allowed.has(arg))) return fail('INVALID_USAGE');

  const releasePath = join(ROOT, 'releases', releaseId, 'release.json');
  const stat = await lstat(releasePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.nlink !== 1
    || (stat.mode & 0o022) !== 0 || stat.size <= 0 || stat.size > 1024 * 1024) {
    return fail('UNTRUSTED_RELEASE');
  }
  const file = await open(releasePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes;
  try {
    bytes = Buffer.alloc(stat.size);
    const read = await file.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length) return fail('UNTRUSTED_RELEASE');
    const after = await file.stat();
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size
      || after.mtimeMs !== stat.mtimeMs) return fail('UNTRUSTED_RELEASE');
  } finally {
    await file.close();
  }

  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 1 || manifest.releaseId !== releaseId) {
    return fail('UNTRUSTED_RELEASE');
  }
  const releaseDigest = createHash('sha256').update(bytes).digest('hex');
  if (!HEX64.test(releaseDigest)) return fail('UNTRUSTED_RELEASE');

  let tunnel;
  if (Object.hasOwn(manifest, 'tunnelCompatibilityDigest')) {
    if (typeof manifest.tunnelCompatibilityDigest !== 'string'
      || !HEX64.test(manifest.tunnelCompatibilityDigest)) return fail('UNTRUSTED_RELEASE');
    tunnel = { enabled: true, compatibilityDigest: manifest.tunnelCompatibilityDigest, credentialRef: 'test-tunnel-key' };
  } else {
    tunnel = { enabled: false };
  }
  const config = { schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId, releaseDigest, tunnel };
  const output = Buffer.from(JSON.stringify(config), 'utf8');

  const configStat = await lstat(CONFIG_DIR);
  if (!configStat.isDirectory() || configStat.uid !== 0 || (configStat.mode & 0o022) !== 0) return fail('UNSAFE_PATH');
  try {
    await lstat(TARGET);
    if (!replace) return fail('CANDIDATE_EXISTS');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const temporary = join(CONFIG_DIR, '.candidate-service.json.write');
  let handle;
  try {
    handle = await open(temporary, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(output);
    await handle.sync();
    await rename(temporary, TARGET);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
  process.stdout.write(`CANDIDATE_STAGED release_id=${releaseId} release_digest=${releaseDigest}\n`);
}

main().catch(() => fail('INTERNAL_ERROR'));
