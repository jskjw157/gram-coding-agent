import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { ServiceConfig } from './contracts.js';
import { parseConfig } from './config.js';
import { hasControls, relativeParts, type InventoryEntry, type ReleaseFiles } from './adapters/trusted-files.js';

export interface ReleaseEvidence { verified: true; safePaths: true; digest: string; sourceCommit: string; lockDigest: string; entries: readonly string[] }
type Entry = { path: string; sha256: string; executable: boolean } | { path: string; target: string };
const required = ['bin/node', 'apps/agent/dist/main.js', 'packages/macos-lifecycle/dist/supervisor-cli.js', 'pnpm-lock.yaml'];
const digest = (value: unknown): value is string => typeof value === 'string' && value.length === 64 && /^[a-f0-9]+$/.test(value);
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function refuse(): never { throw new Error('UNTRUSTED_RELEASE'); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const out: Record<string, unknown> = Object.create(null);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) return refuse();
    out[key] = descriptor.value;
  }
  return out;
}
function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) refuse();
}
function manifestEntries(value: unknown): Entry[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10000) refuse();
  const names = new Set<string>();
  return value.map(raw => {
    const e = record(raw);
    if (typeof e.path !== 'string') return refuse();
    relativeParts(e.path);
    const key = e.path.normalize('NFC').toLowerCase();
    if (names.has(key) || key === 'release.json' || e.path.split('/').some(p => ['.git', 'secrets', 'state', 'browser'].includes(p))) return refuse();
    names.add(key);
    if (Object.hasOwn(e, 'target')) {
      exact(e, ['path', 'target']);
      if (typeof e.target !== 'string' || e.target.length === 0 || e.target.length > 4096
        || e.target.includes('\\') || hasControls(e.target) || posix.isAbsolute(e.target)) return refuse();
      return { path: e.path, target: e.target };
    }
    exact(e, ['path', 'sha256', 'executable']);
    if (!digest(e.sha256) || typeof e.executable !== 'boolean') return refuse();
    return { path: e.path, sha256: e.sha256, executable: e.executable };
  });
}
function verifyLinks(inventory: InventoryEntry[]): void {
  const byPath = new Map(inventory.map(e => [e.path, e]));
  for (const link of inventory.filter(e => e.kind === 'link')) {
    // Do not normalize '..' lexically: preceding symlinks change its meaning.
    // Resolve only the verified inventory; never follow an on-disk link.
    let pending = [...link.path.split('/').slice(0, -1), ...link.target.split('/')];
    const resolved: string[] = [];
    let expansions = 0; let steps = 0;
    while (pending.length > 0) {
      if (++steps > 8192 || pending.length > 4096) refuse();
      const part = pending.shift();
      if (part === undefined) refuse();
      if (part === '' || part === '.') continue;
      if (part === '..') {
        if (resolved.length === 0) refuse();
        resolved.pop(); continue;
      }
      if (relativeParts(part).length !== 1) refuse();
      const entry = byPath.get([...resolved, part].join('/'));
      if (!entry) refuse();
      if (entry.kind === 'link') {
        if (++expansions > 64 || posix.isAbsolute(entry.target)) refuse();
        pending = [...entry.target.split('/'), ...pending];
      } else {
        if (entry.kind === 'file' && pending.length > 0) refuse();
        resolved.push(part);
      }
    }
  }
}

/** Verify independently reviewed bytes, then inventory, then file data. Never
 * execute a release, read credentials, follow a link or authorize installation.
 * Tool metadata is not runtime tool-surface proof; Task 4 must check that too.
 */
export async function inspectRelease(config: ServiceConfig, expectedDigest: string, files: ReleaseFiles): Promise<ReleaseEvidence> {
  try {
    const normalized = parseConfig(config);
    if (!digest(expectedDigest) || expectedDigest !== normalized.releaseDigest) refuse();
    const bytes = await files.read('release.json', 1024 * 1024);
    if (sha(bytes) !== expectedDigest) refuse();
    const m = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
    exact(m, ['schemaVersion', 'releaseId', 'sourceCommit', 'lockDigest', 'files', 'coreTools', 'schemaCompatibility',
      ...(normalized.tunnel.enabled ? ['tunnelCompatibilityDigest'] : [])]);
    if (m.schemaVersion !== 1 || m.releaseId !== normalized.releaseId || typeof m.sourceCommit !== 'string'
      || m.sourceCommit.length !== 40 || !/^[a-f0-9]+$/.test(m.sourceCommit) || !digest(m.lockDigest)
      || !Array.isArray(m.coreTools) || m.coreTools.length !== 1 || m.coreTools[0] !== 'agent_health') refuse();
    const schema = record(m.schemaCompatibility); exact(schema, ['minimum', 'maximum']);
    if (typeof schema.minimum !== 'number' || typeof schema.maximum !== 'number'
      || !Number.isSafeInteger(schema.minimum) || !Number.isSafeInteger(schema.maximum)
      || schema.minimum < 1 || schema.maximum < schema.minimum) refuse();
    if (normalized.tunnel.enabled && m.tunnelCompatibilityDigest !== normalized.tunnel.compatibilityDigest) refuse();
    const entries = manifestEntries(m.files); const map = new Map(entries.map(e => [e.path, e]));
    const needed = [...required, ...(normalized.tunnel.enabled ? ['bin/tunnel-client'] : [])];
    for (const path of needed) {
      const e = map.get(path);
      if (!e || !('sha256' in e) || e.executable !== path.startsWith('bin/')) refuse();
    }
    const lock = map.get('pnpm-lock.yaml');
    if (!lock || !('sha256' in lock) || lock.sha256 !== m.lockDigest) refuse();
    const before = await files.inventory(); const leaves = before.filter(e => e.kind !== 'directory' && e.path !== 'release.json');
    if (leaves.length !== entries.length) refuse();
    for (const e of before) {
      if (e.path === 'release.json') { if (e.kind !== 'file' || e.executable) refuse(); continue; }
      if (e.kind === 'directory') {
        if (!entries.some(item => item.path.startsWith(e.path + '/'))) refuse();
      } else {
        const expected = map.get(e.path);
        if (!expected) refuse();
        if (e.kind === 'link' ? !('target' in expected) || e.target !== expected.target
          : !('sha256' in expected) || e.executable !== expected.executable) refuse();
      }
    }
    verifyLinks(before);
    for (const e of entries) {
      if ('sha256' in e && await files.hash(e.path, 256 * 1024 * 1024) !== e.sha256) refuse();
    }
    if (JSON.stringify(await files.inventory()) !== JSON.stringify(before)
      || sha(await files.read('release.json', 1024 * 1024)) !== expectedDigest) refuse();
    return { verified: true, safePaths: true, digest: expectedDigest, sourceCommit: m.sourceCommit,
      lockDigest: m.lockDigest, entries: entries.map(e => e.path).sort() };
  } catch { return refuse(); }
}
