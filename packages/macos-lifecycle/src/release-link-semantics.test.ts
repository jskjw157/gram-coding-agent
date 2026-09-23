import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseConfig } from './config.js';
import { inspectRelease } from './release-inspection.js';
import { createTrustedFiles } from './adapters/trusted-files.js';
const sha = (data: string) => createHash('sha256').update(data).digest('hex');
const paths = ['bin/node', 'apps/agent/dist/main.js', 'packages/macos-lifecycle/dist/supervisor-cli.js', 'pnpm-lock.yaml'];
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'gram link semantics ')));
  for (const path of paths) {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(root, path), path, { mode: path === 'bin/node' ? 0o700 : 0o600 });
  }
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
async function check(links: Array<{ path: string; target: string }>) {
  for (const link of links) await symlink(link.target, join(root, link.path));
  const bytes = JSON.stringify({ schemaVersion: 1, releaseId: 'lab-001', sourceCommit: 'a'.repeat(40),
    lockDigest: sha('pnpm-lock.yaml'), files: [...paths.map(path => ({ path, sha256: sha(path), executable: path === 'bin/node' })), ...links],
    coreTools: ['agent_health'], schemaCompatibility: { minimum: 1, maximum: 1 } });
  await writeFile(join(root, 'release.json'), bytes, { mode: 0o600 });
  const digest = sha(bytes);
  const config = parseConfig({ schemaVersion: 1, mode: 'LAB_ONLY', runtimeUser: 'gram-agent', releaseId: 'lab-001', releaseDigest: digest, tunnel: { enabled: false } });
  return inspectRelease(config, digest, createTrustedFiles(root, process.getuid?.() ?? -1, async () => true));
}
describe('symlink expansion must precede parent traversal', () => {
  it('rejects leaving the release through a root alias followed by ..', async () => {
    await expect(check([{ path: 'root-alias', target: '.' }, { path: 'bad', target: 'root-alias/../bin/node' }]))
      .rejects.toThrow(/^UNTRUSTED_RELEASE$/);
  });
  it('rejects treating a file as a directory before ..', async () => {
    await expect(check([{ path: 'bad', target: 'pnpm-lock.yaml/../bin/node' }])).rejects.toThrow(/^UNTRUSTED_RELEASE$/);
  });
  it('allows a directory alias followed by .. only when the expanded result stays inside', async () => {
    expect((await check([{ path: 'dir-alias', target: 'apps/agent' }, { path: 'good', target: 'dir-alias/../../bin/node' }])).verified).toBe(true);
  });
});
