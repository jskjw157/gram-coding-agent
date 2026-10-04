/**
 * MAC-02 deterministic release packaging (lane C, #141).
 *
 * Builds a sealed, reproducible release bundle directory:
 *   <destDir>/manifest.json
 *   <destDir>/payload/<sorted relative paths>
 *
 * Guarantees:
 * - Deterministic: entries sorted by path, canonical JSON, fixed modes.
 *   No timestamps, no host-dependent values, no Date.now().
 * - No secrets: credential-shaped content is rejected; findings report rule
 *   names only and never echo matched values. Secret-bearing filenames
 *   (.env, *.pem, *keychain*) are rejected.
 * - No wildcard binds: payload content containing 0.0.0.0 is rejected
 *   (loopback-only policy, AGENTS.md).
 * - No network, no keychain, no subprocess, no lifecycle engine imports.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';

export const RELEASE_LAYOUT_VERSION = 1;

/** File modes allowed in a bundle: data default plus locked-down config. */
const ALLOWED_MODES = new Set(['0644', '0600']);
const DEFAULT_MODE = '0644';

/** Filenames that must never enter a bundle (case-insensitive basename rules). */
const SECRET_PATH_RULES = [
  { rule: 'dotenv-file', test: (base) => base === '.env' || base.startsWith('.env.') },
  { rule: 'pem-file', test: (base) => base.endsWith('.pem') },
  { rule: 'keychain-file', test: (base) => base.includes('keychain') },
];

/**
 * High-signal credential shapes only. Findings carry rule names and offsets;
 * matched values are never returned, logged, or embedded in errors.
 */
const SECRET_CONTENT_RULES = [
  { rule: 'github-token', pattern: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}/ },
  { rule: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
  { rule: 'pem-private-key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { rule: 'slack-token', pattern: /xox[bpas]-[A-Za-z0-9-]{6,}/ },
  { rule: 'openai-key', pattern: /sk-[A-Za-z0-9]{8,}/ },
  { rule: 'google-api-key', pattern: /AIza[A-Za-z0-9_-]{10,}/ },
];

const FORBIDDEN_BIND = '0.0.0.0';
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * @param {Uint8Array|string} bytes
 * @returns {string} lowercase sha256 hex digest.
 */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBytes(content) {
  if (typeof content === 'string') return Buffer.from(content, 'utf8');
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new Error('INVALID_CONTENT: content must be string or Uint8Array');
}

function checkReleaseId(releaseId) {
  if (typeof releaseId !== 'string' || !RELEASE_ID.test(releaseId)) {
    throw new Error('INVALID_RELEASE_ID: use [a-z0-9._-], lead alnum, max 64 chars');
  }
}

function checkPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) {
    throw new Error('INVALID_PATH: empty or oversize path');
  }
  if (
    path.startsWith('/') || path.includes('\\') || path.startsWith('./')
    || path.split('/').includes('..') || path.split('/').includes('')
  ) {
    throw new Error(`INVALID_PATH: must be a clean relative posix path: ${path}`);
  }
}

function checkSecretPath(path) {
  const base = posix.basename(path).toLowerCase();
  for (const { rule, test } of SECRET_PATH_RULES) {
    if (test(base)) throw new Error(`FORBIDDEN_SECRET_PATH ${rule}: ${path}`);
  }
}

/**
 * Scan text for credential shapes.
 * @param {string} text
 * @returns {Array<{rule:string,index:number}>} findings without matched values.
 */
export function scanForSecrets(text) {
  if (typeof text !== 'string') throw new Error('INVALID_CONTENT: scan input must be string');
  const findings = [];
  for (const { rule, pattern } of SECRET_CONTENT_RULES) {
    const at = text.search(pattern);
    if (at >= 0) findings.push({ rule, index: at });
  }
  return findings;
}

/**
 * @param {Array<{path:string,content:string|Uint8Array}>} files
 * @throws when any file content matches a credential rule.
 */
export function assertNoSecrets(files) {
  for (const file of files) {
    const text = toBytes(file.content).toString('utf8');
    const findings = scanForSecrets(text);
    if (findings.length > 0) {
      throw new Error(
        `SECRETS_DETECTED ${findings.map((f) => f.rule).join(',')}: ${file.path}`,
      );
    }
    if (text.includes(FORBIDDEN_BIND)) {
      throw new Error(`FORBIDDEN_BIND 0.0.0.0 rejected (loopback-only): ${file.path}`);
    }
  }
}

function normalizeEntries(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('INVALID_FILES: at least one file is required');
  }
  const seen = new Set();
  const entries = files.map((file) => {
    checkPath(file.path);
    checkSecretPath(file.path);
    const mode = file.mode === undefined ? DEFAULT_MODE : file.mode;
    if (!ALLOWED_MODES.has(mode)) {
      throw new Error(`INVALID_MODE ${mode}: allowed 0644 (data) or 0600 (config): ${file.path}`);
    }
    if (seen.has(file.path)) throw new Error(`DUPLICATE_PATH: ${file.path}`);
    seen.add(file.path);
    const bytes = toBytes(file.content);
    return {
      path: file.path, sha256: sha256Hex(bytes), bytes: bytes.length, mode,
    };
  });
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return entries;
}

/**
 * Plan a release manifest without touching the filesystem.
 */
export function planRelease({ releaseId, files }) {
  checkReleaseId(releaseId);
  assertNoSecrets(files);
  const entries = normalizeEntries(files);
  const totalBytes = entries.reduce((n, e) => n + e.bytes, 0);
  const body = {
    schemaVersion: RELEASE_LAYOUT_VERSION,
    releaseId,
    entries,
  };
  return {
    ...body,
    fileCount: entries.length,
    totalBytes,
    manifestDigest: sha256Hex(JSON.stringify(body)),
  };
}

/**
 * Write a deterministic bundle: manifest.json plus payload tree with fixed
 * modes (dirs 0755, files per-entry mode, manifest 0644). Umask-independent
 * via explicit chmod.
 */
export function writeReleaseBundle({ destDir, releaseId, files }) {
  const manifest = planRelease({ releaseId, files });
  mkdirSync(join(destDir, 'payload'), { recursive: true });
  chmodSync(join(destDir, 'payload'), 0o755);
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const entry of manifest.entries) {
    const target = join(destDir, 'payload', entry.path);
    mkdirSync(dirname(target), { recursive: true });
    let dir = dirname(target);
    const payloadRoot = join(destDir, 'payload');
    while (dir.startsWith(payloadRoot)) {
      chmodSync(dir, 0o755);
      if (dir === payloadRoot) break;
      dir = dirname(dir);
    }
    writeFileSync(target, toBytes(byPath.get(entry.path).content));
    chmodSync(target, entry.mode === '0600' ? 0o600 : 0o644);
  }
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(destDir, 'manifest.json'), serialized, 'utf8');
  chmodSync(join(destDir, 'manifest.json'), 0o644);
  return manifest;
}
