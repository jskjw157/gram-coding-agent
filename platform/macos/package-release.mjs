/**
 * MAC-02 sealed release packager (lane C, #141 repair).
 *
 * Library entry: import { packageRelease, publishRelease } from this module.
 * Importing this module performs no I/O and spawns nothing: all filesystem
 * work happens inside packageRelease()/publishRelease(), and the CLI below
 * runs only under direct execution.
 *
 * Contract (source of truth: #141; consumer: inspectRelease in
 * packages/macos-lifecycle/src/release-inspection.ts, which is NOT modified
 * here and gains no new reader):
 *
 * - packageRelease() copies a verified build source into a NEW staging dir
 *   and writes release.json with the EXACT keys the consumer parses:
 *   schemaVersion, releaseId, sourceCommit, lockDigest, files, coreTools,
 *   schemaCompatibility, plus tunnelCompatibilityDigest only when the tunnel
 *   is enabled. coreTools is always ['agent_health'].
 * - files entries are exactly {path,sha256,executable} or {path,target},
 *   sorted by path; releaseJson bytes are canonical (fixed key order, compact
 *   JSON, single trailing newline) so the same input yields identical bytes.
 * - Required entries: bin/node, apps/agent/dist/main.js,
 *   packages/macos-lifecycle/dist/supervisor-cli.js, pnpm-lock.yaml,
 *   bin/file-acl, bin/peer-owner, plus bin/tunnel-client when the tunnel is
 *   enabled. A real base without supervisor-cli.js fails closed (no stubs).
 * - lockDigest is the sha256 of the ACTUAL pnpm-lock.yaml bytes staged; an
 *   explicitly supplied lockBytes value must equal those bytes or the run is
 *   refused (LOCK_MISMATCH). sourceCommit/schemaCompatibility are bound
 *   verbatim from options (never guessed).
 * - Refusals: DIRTY_SOURCE (.git, secret-bearing basenames), EXTRA_FILE
 *   (undeclared inventory), MISSING_FILE, EXECUTABLE_MISMATCH (bin/* must be
 *   executable, everything else must not), SYMLINK_ESCAPE (absolute, escaping,
 *   cyclic, or unresolvable internal links).
 * - Staging and final publication are separate: packageRelease() never
 *   creates or touches destDir; publishRelease() copies a staged bundle to a
 *   destDir that must NOT already exist (OUTPUT_EXISTS otherwise). A failure
 *   removes only the new staging/dest the call created; pre-existing output
 *   and the source tree are never modified or purged.
 *
 * No network, no keychain, no signing, no install, no dependency changes.
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASE_SCHEMA_VERSION = 1;
const CORE_TOOLS = ['agent_health'];
const BASE_REQUIRED = [
  'bin/node',
  'apps/agent/dist/main.js',
  'packages/macos-lifecycle/dist/supervisor-cli.js',
  'pnpm-lock.yaml',
];
const HELPER_REQUIRED = ['bin/file-acl', 'bin/peer-owner'];
const TUNNEL_BIN = 'bin/tunnel-client';
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const FORBIDDEN_ROOTS = new Set(['secrets', 'state', 'browser']);

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function toBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('INVALID_OPTIONS: bytes must be string or Uint8Array');
}

function hasControls(value) {
  return [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

/** Clean relative posix path per the consumer's relativeParts rules. */
function checkRelPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    throw new Error(`INVALID_PATH: bad length: ${path}`);
  }
  if (isAbsolute(path) || path.includes('\\') || hasControls(path)) {
    throw new Error(`INVALID_PATH: must be clean relative posix: ${path}`);
  }
  const parts = path.split('/');
  if (parts.length > 64 || parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`INVALID_PATH: bad segment: ${path}`);
  }
  return parts;
}

function secretBasename(rel) {
  const base = posix.basename(rel).toLowerCase();
  return base === '.env' || base.startsWith('.env.') || base.endsWith('.pem') || base.includes('keychain');
}

function normalizeOptions(options) {
  if (options === null || typeof options !== 'object') throw new Error('INVALID_OPTIONS: options object required');
  const {
    sourceDir,
    stagingDir,
    releaseId,
    sourceCommit,
    lockBytes,
    schemaCompatibility,
    tunnel = { enabled: false },
    additionalFiles = [],
    additionalLinks = [],
  } = options;
  if (!isAbsolute(sourceDir ?? '') || !isAbsolute(stagingDir ?? '')) {
    throw new Error('INVALID_OPTIONS: sourceDir and stagingDir must be absolute paths');
  }
  if (typeof releaseId !== 'string' || !RELEASE_ID.test(releaseId)) {
    throw new Error('INVALID_RELEASE_ID: use [A-Za-z0-9._-], lead alnum, max 64 chars');
  }
  if (typeof sourceCommit !== 'string' || !HEX40.test(sourceCommit)) {
    throw new Error('INVALID_SOURCE_COMMIT: must be 40 lowercase hex chars');
  }
  if (
    schemaCompatibility === null ||
    typeof schemaCompatibility !== 'object' ||
    Object.keys(schemaCompatibility).length !== 2 ||
    !Number.isSafeInteger(schemaCompatibility.minimum) ||
    !Number.isSafeInteger(schemaCompatibility.maximum) ||
    schemaCompatibility.minimum < 1 ||
    schemaCompatibility.maximum < schemaCompatibility.minimum
  ) {
    throw new Error('INVALID_SCHEMA_COMPATIBILITY: supply {minimum,maximum} ints, minimum>=1, maximum>=minimum');
  }
  const tunnelEnabled = tunnel?.enabled === true;
  if (tunnelEnabled) {
    if (typeof tunnel.compatibilityDigest !== 'string' || !HEX64.test(tunnel.compatibilityDigest)) {
      throw new Error('INVALID_TUNNEL: enabled tunnel needs a 64 hex compatibilityDigest');
    }
  } else if (tunnel?.enabled !== false) {
    throw new Error('INVALID_TUNNEL: tunnel must be {enabled:false} or {enabled:true,...}');
  }
  if (!Array.isArray(additionalFiles) || !Array.isArray(additionalLinks)) {
    throw new Error('INVALID_OPTIONS: additionalFiles/additionalLinks must be arrays');
  }
  const seen = new Set();
  for (const path of additionalFiles) {
    checkRelPath(path);
    if (path === 'release.json' || (path.split('/').includes('.git') || FORBIDDEN_ROOTS.has(path.split('/')[0]))) {
      throw new Error(`INVALID_PATH: forbidden entry: ${path}`);
    }
    if (seen.has(path)) throw new Error(`DUPLICATE_PATH: ${path}`);
    seen.add(path);
  }
  for (const link of additionalLinks) {
    if (link === null || typeof link !== 'object') throw new Error('INVALID_OPTIONS: link must be {path,target}');
    checkRelPath(link.path);
    if (typeof link.target !== 'string') throw new Error('INVALID_OPTIONS: link target must be a string');
    if (link.path === 'release.json' || link.(path.split('/').includes('.git') || FORBIDDEN_ROOTS.has(path.split('/')[0]))) {
      throw new Error(`INVALID_PATH: forbidden entry: ${link.path}`);
    }
    if (seen.has(link.path)) throw new Error(`DUPLICATE_PATH: ${link.path}`);
    seen.add(link.path);
  }
  return {
    sourceDir,
    stagingDir,
    releaseId,
    sourceCommit,
    lockBytes: lockBytes === undefined ? undefined : toBytes(lockBytes),
    schemaCompatibility: { minimum: schemaCompatibility.minimum, maximum: schemaCompatibility.maximum },
    tunnelEnabled,
    tunnelDigest: tunnelEnabled ? tunnel.compatibilityDigest : undefined,
    additionalFiles: [...additionalFiles],
    additionalLinks: additionalLinks.map((l) => ({ path: l.path, target: l.target })),
  };
}

/** Lexically resolve an allowlisted link target against source inventory. */
function resolveLinkTarget(fromPath, target, fileSet, dirSet, linkMap) {
  if (target.length === 0 || target.length > 4096 || target.includes('\\') || hasControls(target) || posix.isAbsolute(target)) {
    throw new Error(`SYMLINK_ESCAPE: bad target for ${fromPath}`);
  }
  let pending = [...fromPath.split('/').slice(0, -1), ...target.split('/')];
  const resolved = [];
  let expansions = 0;
  let steps = 0;
  while (pending.length > 0) {
    if (++steps > 8192 || pending.length > 4096) throw new Error(`SYMLINK_ESCAPE: unresolvable ${fromPath}`);
    const part = pending.shift();
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (resolved.length === 0) throw new Error(`SYMLINK_ESCAPE: ${fromPath} leaves the bundle`);
      resolved.pop();
      continue;
    }
    const candidate = [...resolved, part].join('/');
    const hop = linkMap.get(candidate);
    if (hop !== undefined) {
      if (++expansions > 64) throw new Error(`SYMLINK_ESCAPE: cycle at ${fromPath}`);
      pending = [...hop.split('/'), ...pending];
      continue;
    }
    if (fileSet.has(candidate)) {
      if (pending.length > 0) throw new Error(`SYMLINK_ESCAPE: ${fromPath} traverses a file`);
      resolved.push(part);
      continue;
    }
    if (!dirSet.has(candidate)) {
      throw new Error(`SYMLINK_ESCAPE: ${fromPath} points outside the bundle`);
    }
    resolved.push(part);
  }
  const final = resolved.join('/');
  if (final !== '' && !fileSet.has(final) && !dirSet.has(final)) {
    throw new Error(`SYMLINK_ESCAPE: ${fromPath} has no target`);
  }
}

function scanSource(sourceDir, requiredFiles, allowedFiles, allowedLinks) {
  const stat = lstatSync(sourceDir);
  if (!stat.isDirectory()) throw new Error('INVALID_OPTIONS: sourceDir is not a directory');
  const found = new Map();
  const walk = (abs) => {
    for (const name of readdirSync(abs).sort()) {
      if (hasControls(name)) throw new Error(`DIRTY_SOURCE: control chars in ${name}`);
      const child = join(abs, name);
      const rel = relative(sourceDir, child).split(sep).join('/');
      checkRelPath(rel);
      if (rel.split('/').includes('.git') || FORBIDDEN_ROOTS.has(rel.split('/')[0]) || secretBasename(rel)) {
        throw new Error(`DIRTY_SOURCE: not shippable: ${rel}`);
      }
      const st = lstatSync(child);
      if (st.isSymbolicLink()) {
        found.set(rel, { kind: 'link' });
      } else if (st.isDirectory()) {
        found.set(rel, { kind: 'directory' });
        walk(child);
      } else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) throw new Error(`OVERSIZE_FILE: ${rel}`);
        found.set(rel, { kind: 'file', mode: st.mode & 0o777 });
      } else {
        throw new Error(`UNKNOWN_FILE: only files, dirs, links: ${rel}`);
      }
    }
  };
  walk(sourceDir);

  const allowedFileSet = new Set([...requiredFiles, ...allowedFiles]);
  const allowedLinkMap = new Map(allowedLinks.map((l) => [l.path, l.target]));
  for (const [rel, entry] of found) {
    if (entry.kind === 'directory') continue;
    if (entry.kind === 'link' && !allowedLinkMap.has(rel)) {
      throw new Error(`EXTRA_FILE: undeclared link: ${rel}`);
    }
    if (entry.kind === 'file' && !allowedFileSet.has(rel)) {
      throw new Error(`EXTRA_FILE: undeclared file: ${rel}`);
    }
  }
  for (const rel of allowedFileSet) {
    const entry = found.get(rel);
    if (entry === undefined || entry.kind !== 'file') {
      throw new Error(`MISSING_FILE: required bundle entry absent: ${rel}`);
    }
  }
  for (const { path } of allowedLinks) {
    const entry = found.get(path);
    if (entry === undefined || entry.kind !== 'link') {
      throw new Error(`MISSING_FILE: declared link absent: ${path}`);
    }
  }
  for (const [rel, entry] of found) {
    if (entry.kind !== 'directory') continue;
    const parents = [...allowedFileSet, ...allowedLinkMap.keys()].some((p) => p.startsWith(`${rel}/`));
    if (!parents) throw new Error(`EXTRA_FILE: undeclared directory: ${rel}`);
  }
  for (const rel of allowedFileSet) {
    const executable = (found.get(rel).mode & 0o111) !== 0;
    if (rel.startsWith('bin/') !== executable) {
      throw new Error(`EXECUTABLE_MISMATCH: ${rel} executable=${executable}`);
    }
  }
  for (const { path, target } of allowedLinks) {
    const fileSet = allowedFileSet;
    const dirSet = new Set([...found].filter(([, e]) => e.kind === 'directory').map(([rel]) => rel));
    resolveLinkTarget(path, target, fileSet, dirSet, allowedLinkMap);
  }
  return found;
}

function buildManifest({ releaseId, sourceCommit, lockDigest, schemaCompatibility, tunnelEnabled, tunnelDigest, fileEntries }) {
  const manifest = {
    schemaVersion: RELEASE_SCHEMA_VERSION,
    releaseId,
    sourceCommit,
    lockDigest,
    files: fileEntries,
    coreTools: [...CORE_TOOLS],
    schemaCompatibility: { minimum: schemaCompatibility.minimum, maximum: schemaCompatibility.maximum },
    ...(tunnelEnabled ? { tunnelCompatibilityDigest: tunnelDigest } : {}),
  };
  const releaseJson = `${JSON.stringify(manifest)}\n`;
  return { releaseJson, digest: sha256Hex(Buffer.from(releaseJson, 'utf8')) };
}

function writeTree(root, files) {
  const byPath = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const file of byPath) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    if ('target' in file) {
      symlinkSync(file.target, target);
    } else {
      writeFileSync(target, file.bytes);
      chmodSync(target, file.executable ? 0o755 : 0o644);
    }
  }
  const dirs = new Set([root]);
  for (const file of files) {
    let dir = dirname(join(root, file.path));
    while (dir.startsWith(root)) {
      dirs.add(dir);
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  for (const dir of dirs) chmodSync(dir, 0o755);
}

/**
 * Seal a release: validate the source tree, stage an exact copy plus the
 * canonical release.json, and return the staged bytes and their digest.
 */
export function packageRelease(options) {
  const opt = normalizeOptions(options);
  if (existsSync(opt.stagingDir)) {
    throw new Error(`OUTPUT_EXISTS: staging already exists, refusing to overwrite: ${opt.stagingDir}`);
  }
  const requiredFiles = [...BASE_REQUIRED, ...HELPER_REQUIRED, ...(opt.tunnelEnabled ? [TUNNEL_BIN] : [])];
  scanSource(opt.sourceDir, requiredFiles, opt.additionalFiles, opt.additionalLinks);

  const readSource = (rel) => readFileSync(join(opt.sourceDir, rel));
  const lockFileBytes = readSource('pnpm-lock.yaml');
  if (opt.lockBytes !== undefined && !opt.lockBytes.equals(lockFileBytes)) {
    throw new Error('LOCK_MISMATCH: supplied lock bytes differ from source pnpm-lock.yaml');
  }
  const lockDigest = sha256Hex(lockFileBytes);

  const fileEntries = [];
  const payload = [];
  for (const rel of [...requiredFiles, ...opt.additionalFiles].sort()) {
    const bytes = readSource(rel);
    if (rel === 'pnpm-lock.yaml' && sha256Hex(bytes) !== lockDigest) {
      throw new Error('LOCK_MISMATCH: staged lock drifted mid-run');
    }
    const executable = rel.startsWith('bin/');
    fileEntries.push({ path: rel, sha256: sha256Hex(bytes), executable });
    payload.push({ path: rel, bytes, executable });
  }
  for (const link of [...opt.additionalLinks].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    fileEntries.push({ path: link.path, target: link.target });
    payload.push({ path: link.path, target: link.target });
  }
  fileEntries.sort((a, b) => (a.path < b.path ? -1 : 1));

  const { releaseJson, digest } = buildManifest({
    releaseId: opt.releaseId,
    sourceCommit: opt.sourceCommit,
    lockDigest,
    schemaCompatibility: opt.schemaCompatibility,
    tunnelEnabled: opt.tunnelEnabled,
    tunnelDigest: opt.tunnelDigest,
    fileEntries,
  });

  mkdirSync(opt.stagingDir);
  try {
    writeTree(opt.stagingDir, payload);
    writeFileSync(join(opt.stagingDir, 'release.json'), releaseJson, 'utf8');
    chmodSync(join(opt.stagingDir, 'release.json'), 0o644);
  } catch (error) {
    rmSync(opt.stagingDir, { recursive: true, force: true });
    throw error;
  }
  return {
    stagingDir: opt.stagingDir,
    releaseJson,
    digest,
    entries: fileEntries.map((e) => e.path),
  };
}

function copyTree(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const name of readdirSync(fromDir).sort()) {
    const from = join(fromDir, name);
    const to = join(toDir, name);
    const st = lstatSync(from);
    if (st.isSymbolicLink()) {
      symlinkSync(readlinkSync(from), to);
    } else if (st.isDirectory()) {
      copyTree(from, to);
      chmodSync(to, 0o755);
    } else if (st.isFile()) {
      writeFileSync(to, readFileSync(from));
      chmodSync(to, (st.mode & 0o111) !== 0 ? 0o755 : 0o644);
    } else {
      throw new Error(`UNKNOWN_FILE: cannot publish ${from}`);
    }
  }
  chmodSync(toDir, 0o755);
}

/**
 * Publish a staged bundle to its final location. The destination must not
 * exist: pre-existing output is never overwritten, purged, or half-modified.
 */
export function publishRelease({ stagingDir, destDir } = {}) {
  if (!isAbsolute(stagingDir ?? '') || !isAbsolute(destDir ?? '')) {
    throw new Error('INVALID_OPTIONS: stagingDir and destDir must be absolute paths');
  }
  if (existsSync(destDir)) {
    throw new Error(`OUTPUT_EXISTS: destination already exists, refusing to overwrite: ${destDir}`);
  }
  let staged;
  try {
    staged = readFileSync(join(stagingDir, 'release.json'));
  } catch {
    throw new Error(`INVALID_STAGING: no release.json in ${stagingDir}`);
  }
  const digest = sha256Hex(staged);
  try {
    copyTree(stagingDir, destDir);
  } catch (error) {
    rmSync(destDir, { recursive: true, force: true });
    throw error;
  }
  return { destDir, digest, releaseJson: staged.toString('utf8') };
}

/* Direct-execution entry. Library imports never reach here. */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    if (i < 0 || i + 1 >= args.length) return undefined;
    return args[i + 1];
  };
  const collect = (flag) => {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[i + 1]);
    }
    return out;
  };
  try {
    const tunnelDigest = get('--tunnel-digest');
    const result = packageRelease({
      sourceDir: get('--source'),
      stagingDir: get('--staging'),
      releaseId: get('--release-id'),
      sourceCommit: get('--source-commit'),
      lockBytes: get('--lock-file') ? readFileSync(get('--lock-file')) : undefined,
      schemaCompatibility: { minimum: Number(get('--schema-min')), maximum: Number(get('--schema-max')) },
      tunnel: tunnelDigest ? { enabled: true, compatibilityDigest: tunnelDigest } : { enabled: false },
      additionalFiles: collect('--allow'),
      additionalLinks: collect('--link').map((spec) => {
        const eq = spec.indexOf('=');
        if (eq < 0) throw new Error('INVALID_OPTIONS: --link needs path=target');
        return { path: spec.slice(0, eq), target: spec.slice(eq + 1) };
      }),
    });
    const publishTo = get('--publish');
    const final = publishTo ? publishRelease({ stagingDir: result.stagingDir, destDir: publishTo }) : undefined;
    process.stdout.write(`${JSON.stringify({ stagingDir: result.stagingDir, destDir: final?.destDir ?? null, digest: result.digest })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  }
}
