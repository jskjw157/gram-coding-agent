import { lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageRelease, publishRelease } from './package-release.mjs';

const REQUIRED = new Set([
  'bin/node',
  'apps/agent/dist/main.js',
  'packages/macos-lifecycle/dist/supervisor-cli.js',
  'pnpm-lock.yaml',
  'bin/file-acl',
  'bin/peer-owner',
]);

function relPosix(root, absolute) {
  const rel = relative(root, absolute).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel.includes('/../')) throw new Error('INVALID_PATH');
  return rel;
}

function inventory(root) {
  const files = [];
  const links = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const absolute = join(dir, name);
      const rel = relPosix(root, absolute);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        links.push({ path: rel, target: readlinkSync(absolute) });
      } else if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        if (rel !== 'release.json' && !REQUIRED.has(rel)) files.push(rel);
      } else {
        throw new Error(`UNKNOWN_FILE: ${rel}`);
      }
    }
  };
  visit(root);
  return { files, links };
}

export function sealPreparedCoreRelease(options) {
  const { sourceDir, stagingDir, destDir, releaseId, sourceCommit } = options ?? {};
  if (![sourceDir, stagingDir, destDir].every(value => typeof value === 'string' && isAbsolute(value))) {
    throw new Error('INVALID_OPTIONS: absolute source/staging/dest required');
  }
  const extra = inventory(sourceDir);
  const staged = packageRelease({
    sourceDir, stagingDir, releaseId, sourceCommit,
    schemaCompatibility: { minimum: 1, maximum: 1 },
    tunnel: { enabled: false },
    additionalFiles: extra.files,
    additionalLinks: extra.links,
  });
  const published = publishRelease({ stagingDir: staged.stagingDir, destDir });
  if (published.digest !== staged.digest) throw new Error('PUBLISH_DIGEST_MISMATCH');
  return {
    releaseId, digest: staged.digest, destDir: published.destDir,
    fileCount: staged.entries.length,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
  };
  try {
    const result = sealPreparedCoreRelease({
      sourceDir: get('--source'), stagingDir: get('--staging'), destDir: get('--publish'),
      releaseId: get('--release-id'), sourceCommit: get('--source-commit'),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'INTERNAL_ERROR'}\n`);
    process.exitCode = 1;
  }
}
