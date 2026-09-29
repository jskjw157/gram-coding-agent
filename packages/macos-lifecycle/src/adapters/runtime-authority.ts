import { lstat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { root, type ServiceConfig } from '../contracts.js';
import { configDigest, parseConfig } from '../config.js';
import { ExecutionLeaseStore } from '../execution-lease.js';
import { inspectRelease } from '../release-inspection.js';
import type { CoreAuthority } from './native-core.js';
import { createTrustedFiles, type AclProbe } from './trusted-files.js';
import { inspectMacHost, inspectMacAccount, type LocalAccount } from './macos-inspection.js';
import { copyRuntimeLayout, inspectRuntimeDirectories, type RuntimeLayout } from './runtime-directories.js';
import { createExecutionFilesAt } from './execution-files.js';
import { createNativePeerProof, type ExecutableIdentity, type NativePeerProofPort } from './owned-process.js';

/** Trusted bootstrap input, NOT candidate release.json/CLI/MCP data. Independent
 * review/pin provisioning and the bootstrap ACL verifier remain operator trust
 * anchors. This module consumes those capabilities; it cannot mint their trust.
 */
export interface RuntimeReview {
  config: ServiceConfig;
  configDigest: string;
  nodeDigest: string;
  fileAclDigest: string;
  peerOwnerDigest: string;
}
export interface RuntimeEnvironment {
  host(): { platform: string; arch: string; nodeVersion: string };
  account(): Promise<LocalAccount | null>;
  identity(): { uid: number; gid: number; groups: readonly number[] };
}
export interface ReviewedCoreRuntime { authority: CoreAuthority; execution: ExecutionLeaseStore }
function refuse(): never { throw new Error('CORE_AUTHORITY_UNAVAILABLE'); }
function check(signal: AbortSignal): void { if (signal.aborted) refuse(); }
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) refuse();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) refuse();
  const out: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) refuse(); out[key] = d.value;
  }
  return out;
}
function digest(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/u.test(value);
}
function copyReview(value: RuntimeReview): Readonly<RuntimeReview> {
  const v = data(value, ['config', 'configDigest', 'nodeDigest', 'fileAclDigest', 'peerOwnerDigest']);
  const config = parseConfig(v.config); Object.freeze(config.tunnel); Object.freeze(config);
  if (!digest(v.configDigest) || v.configDigest !== configDigest(config) || !digest(v.nodeDigest)
    || !digest(v.fileAclDigest) || !digest(v.peerOwnerDigest)) refuse();
  return Object.freeze({ config, configDigest: v.configDigest, nodeDigest: v.nodeDigest,
    fileAclDigest: v.fileAclDigest, peerOwnerDigest: v.peerOwnerDigest });
}
function id(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value < 0xffff_ffff;
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
    && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function bounded<T>(ms: number, parent: AbortSignal, use: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), ms);
  const signal = AbortSignal.any([parent, controller.signal]);
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('CORE_AUTHORITY_UNAVAILABLE'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { check(signal); return await Promise.race([use(signal), cancelled]); }
  finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); controller.abort(); }
}

/** Fixed production scope; no directory creation, installation or credentials.
 * Supplying just a self-hashed candidate manifest is intentionally insufficient.
 */
export async function bindReviewedCoreRuntime(review?: RuntimeReview, bootstrapAcl?: AclProbe,
  signal: AbortSignal = new AbortController().signal): Promise<ReviewedCoreRuntime | null> {
  if (!review || typeof bootstrapAcl !== 'function') return null;
  return bindReviewedCoreRuntimeAt({ anchor: '/', relative: root.slice(1), ownerUid: 0 }, review, bootstrapAcl, {
    host: inspectMacHost, account: inspectMacAccount,
    identity: () => ({ uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, groups: process.getgroups?.() ?? [] }),
  }, signal);
}

/** Internal fixture/composition port, never configuration or MCP path input.
 * Private directory identities are pinned across store reads/writes. The
 * environment/provenance providers are trusted dependencies, not booleans from
 * a tool response. Root/admin and hostile same-UID code are outside isolation.
 */
export async function bindReviewedCoreRuntimeAt(inputLayout: RuntimeLayout, inputReview: RuntimeReview,
  bootstrapAcl: AclProbe, inputEnvironment: RuntimeEnvironment, parent: AbortSignal): Promise<ReviewedCoreRuntime | null> {
  try {
    const layout = copyRuntimeLayout(inputLayout); const review = copyReview(inputReview);
    if (typeof bootstrapAcl !== 'function') refuse();
    const environment = Object.freeze({ host: inputEnvironment.host.bind(inputEnvironment),
      account: inputEnvironment.account.bind(inputEnvironment), identity: inputEnvironment.identity.bind(inputEnvironment) });
    return await bounded(10000, parent, async signal => {
      async function context(abort: AbortSignal): Promise<LocalAccount> {
        check(abort);
        const host = data(environment.host(), ['platform', 'arch', 'nodeVersion']);
        if (host.platform !== 'darwin' || host.arch !== 'arm64' || typeof host.nodeVersion !== 'string'
          || !/^24\.[0-9]+\.[0-9]+$/u.test(host.nodeVersion)) refuse();
        const a = data(await environment.account(), ['name', 'uid', 'gid', 'admin', 'groupsComplete']); check(abort);
        const p = data(environment.identity(), ['uid', 'gid', 'groups']);
        if (a.name !== 'gram-agent' || a.admin !== false || a.groupsComplete !== true || !id(a.uid, 1) || !id(a.gid, 0)
          || p.uid !== a.uid || p.gid !== a.gid || !Array.isArray(p.groups) || p.groups.length === 0 || p.groups.length > 128
          || p.groups.some(g => !id(g, 0)) || !p.groups.includes(a.gid) || p.groups.includes(80) || p.groups.includes(0)) refuse();
        return Object.freeze({ name: 'gram-agent', uid: a.uid, gid: a.gid, admin: false, groupsComplete: true });
      }
      const initialAccount = await context(signal);
      const directories = await inspectRuntimeDirectories(layout, initialAccount.uid, bootstrapAcl, signal);
      const configFiles = createTrustedFiles(layout.anchor, layout.ownerUid, bootstrapAcl, layout.relative + '/config');
      const releasePrefix = layout.relative + '/releases/' + review.config.releaseId;
      const releasePath = join(layout.anchor, releasePrefix);
      const releaseFiles = createTrustedFiles(layout.anchor, layout.ownerUid, bootstrapAcl, releasePrefix);
      const rawRecords = createExecutionFilesAt(directories.runPolicy);
      const execution = new ExecutionLeaseStore(Object.freeze({
        async read(role) { await directories.verify(); const value = await rawRecords.read(role); await directories.verify(); return value; },
        async compareAndSwap(role, expected, slot, bytes) {
          await directories.verify(); await rawRecords.compareAndSwap(role, expected, slot, bytes); await directories.verify();
        },
      }));
      async function unchangedContext(abort: AbortSignal): Promise<void> {
        if (JSON.stringify(await context(abort)) !== JSON.stringify(initialAccount)) refuse();
        await directories.verify(); check(abort);
      }
      async function configuration(abort: AbortSignal): Promise<Buffer> {
        check(abort); const bytes = await configFiles.read('service.json', 262144); check(abort);
        const actual = parseConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        if (configDigest(actual) !== review.configDigest) refuse(); return bytes;
      }
      async function executable(path: 'bin/node' | 'bin/file-acl' | 'bin/peer-owner', pin: string,
        abort: AbortSignal): Promise<ExecutableIdentity> {
        check(abort); const absolute = join(releasePath, path); const before = await lstat(absolute, { bigint: true });
        if (!before.isFile() || before.uid !== BigInt(layout.ownerUid) || before.nlink !== 1n
          || (before.mode & 0o6022n) !== 0n || (before.mode & 0o111n) === 0n) refuse();
        if (await releaseFiles.hash(path, 256 * 1024 * 1024) !== pin
          || !sameFile(before, await lstat(absolute, { bigint: true }))) refuse();
        check(abort); return Object.freeze({ dev: before.dev, ino: before.ino });
      }
      async function validate(abort: AbortSignal): Promise<ExecutableIdentity> {
        await unchangedContext(abort); const before = await configuration(abort);
        await inspectRelease(review.config, review.config.releaseDigest, releaseFiles); check(abort);
        const node = await executable('bin/node', review.nodeDigest, abort);
        await executable('bin/file-acl', review.fileAclDigest, abort);
        await executable('bin/peer-owner', review.peerOwnerDigest, abort);
        if (!before.equals(await configuration(abort))) refuse();
        await unchangedContext(abort); return node;
      }
      // A factory does not provision, clear or acquire the execution record.
      await validate(signal); await execution.read('core'); check(signal);
      const nativeProof = createNativePeerProof(join(releasePath, 'bin/peer-owner'));
      async function proofUse<T>(abort: AbortSignal, fallback: T, use: (active: AbortSignal) => Promise<T>): Promise<T> {
        try {
          return await bounded(2000, abort, async active => {
            await unchangedContext(active); await executable('bin/peer-owner', review.peerOwnerDigest, active);
            const result = await use(active);
            await executable('bin/peer-owner', review.peerOwnerDigest, active); await unchangedContext(active);
            return result;
          });
        } catch { return fallback; }
      }
      const proof: NativePeerProofPort = Object.freeze({
        async capture(request, abort) {
          try { const copy = structuredClone(request); return await proofUse(abort, null, s => nativeProof.capture(copy, s)); }
          catch { return null; }
        },
        async current(request, abort) {
          try { const copy = structuredClone(request); return await proofUse(abort, 'UNKNOWN', s => nativeProof.current(copy, s)); }
          catch { return 'UNKNOWN'; }
        },
        async peer(request, abort) {
          try { const copy = structuredClone(request); return await proofUse(abort, 'UNKNOWN', s => nativeProof.peer(copy, s)); }
          catch { return 'UNKNOWN'; }
        },
      });
      const authority: CoreAuthority = Object.freeze({
        async acquire(input, abort) {
          try {
            const config = parseConfig(input); if (configDigest(config) !== review.configDigest) return null;
            return await bounded(10000, abort, async active => {
              const node = await validate(active);
              const occupied = await execution.read('core'); check(active);
              if (occupied.state !== 'HELD' || occupied.configDigest !== review.configDigest
                || occupied.releaseDigest !== review.config.releaseDigest) return null;
              return Object.freeze({ configDigest: review.configDigest, account: initialAccount, executable: node, proof });
            });
          } catch { return null; }
        },
      });
      return Object.freeze({ authority, execution });
    });
  } catch { return null; }
}
