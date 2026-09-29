import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configDigest } from '../../config.js';
import type { ServiceConfig } from '../../contracts.js';
import { ExecutionLeaseStore } from '../../execution-lease.js';
import { createExecutionFilesAt } from '../../adapters/execution-files.js';
import type { RuntimeReview, RuntimeEnvironment } from '../../adapters/runtime-authority.js';
import type { RuntimeLayout } from '../../adapters/runtime-directories.js';
import type { AclProbe } from '../../adapters/trusted-files.js';
export const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex');
export async function fixture() {
  const uid = process.getuid?.() ?? 501; const gid = process.getgid?.() ?? 20;
  const anchor = await realpath(await mkdtemp(join(tmpdir(), 'gram runtime review ')));
  await chmod(anchor, 0o700);
  const relative = 'installed'; const base = join(anchor, relative); const releaseId = 'lab-authority';
  const release = join(base, 'releases', releaseId);
  await mkdir(release, { recursive: true, mode: 0o700 });
  for (const name of ['config', 'run', 'state', 'secrets', 'logs']) await mkdir(join(base, name), { mode: 0o700 });
  const payloads: Record<string, string> = {
    'bin/node': 'reviewed-node-fixture', 'bin/file-acl': 'reviewed-acl-fixture', 'bin/peer-owner': 'reviewed-peer-fixture',
    'apps/agent/dist/main.js': 'export {};\n', 'packages/macos-lifecycle/dist/supervisor-cli.js': 'export {};\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  };
  const entries = [];
  for (const [path, bytes] of Object.entries(payloads)) {
    await mkdir(join(release, path, '..'), { recursive: true, mode: 0o700 });
    const executable = path.startsWith('bin/');
    await writeFile(join(release, path), bytes, { mode: executable ? 0o700 : 0o600 });
    entries.push({ path, sha256: hash(bytes), executable });
  }
  const manifest = { schemaVersion: 1, releaseId, sourceCommit: '1'.repeat(40),
    lockDigest: hash(payloads['pnpm-lock.yaml'] ?? ''), files: entries,
    coreTools: ['agent_health'], schemaCompatibility: { minimum: 1, maximum: 1 } };
  const bytes = JSON.stringify(manifest) + '\n';
  await writeFile(join(release, 'release.json'), bytes, { mode: 0o600 });
  const config: ServiceConfig = { schemaVersion: 1, mode: 'LAB_ONLY', releaseId, releaseDigest: hash(bytes),
    runtimeUser: 'gram-agent', tunnel: { enabled: false } };
  await writeFile(join(base, 'config/service.json'), JSON.stringify(config) + '\n', { mode: 0o600 });
  await writeFile(join(base, 'secrets/do-not-read'), 'SYNTHETIC_UNREAD_SECRET', { mode: 0o000 });
  const acl: AclProbe = async () => true;
  const layout: RuntimeLayout = { anchor, relative, ownerUid: uid };
  const environment: RuntimeEnvironment = {
    host: () => ({ platform: 'darwin', arch: 'arm64', nodeVersion: '24.0.0' }),
    account: async () => ({ name: 'gram-agent', uid, gid, admin: false, groupsComplete: true }),
    identity: () => ({ uid, gid, groups: [gid] }),
  };
  const review: RuntimeReview = { config, configDigest: configDigest(config),
    nodeDigest: hash(payloads['bin/node'] ?? ''), fileAclDigest: hash(payloads['bin/file-acl'] ?? ''),
    peerOwnerDigest: hash(payloads['bin/peer-owner'] ?? '') };
  const runPolicy = { anchor, relative: relative + '/run', ancestorUid: uid, stateUid: uid, acl };
  const execution = new ExecutionLeaseStore(createExecutionFilesAt(runPolicy));
  await execution.initializeNew('core');
  return { uid, gid, anchor, base, release, layout, environment, review, acl, execution, runPolicy };
}
export async function snapshot(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(root: string, prefix: string): Promise<void> {
    for (const item of await readdir(root, { withFileTypes: true })) {
      const key = prefix + item.name;
      if (item.isDirectory()) await walk(join(root, item.name), key + '/');
      else if (key !== 'secrets/do-not-read') result[key] = hash(await readFile(join(root, item.name)));
    }
  }
  await walk(path, ''); return result;
}
