import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRedactor } from '@gram/secrets';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalOperationRepository, openDatabase } from '@gram/persistence';
import { LocalOwnerConsent } from './local-owner-consent.js';
import type { NativeOwnerPresenceVerifier } from './local-owner-consent.js';
import { LocalRecoveryStore } from './local-recovery-store.js';
import { OwnerWorkspaceCore } from './owner-workspace-core.js';
import {
  NativeWorkspaceDeniedError,
  NativeWorkspaceUnresolvedError,
} from './windows-workspace-client.js';
import type { NativeWorkspaceOperation, NativeWorkspaceReply } from './windows-workspace-client.js';

/**
 * These are controller state-machine tests. The backend and owner verifier are
 * synthetic and provide no evidence of native containment, OS authority, human
 * presence, deployed API composition, or security integration.
 *
 * The supplied real recovery store requires Linux /proc and POSIX permissions.
 * Run the agent suite under its required Linux/WSL runtime.
 */
function present<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('Missing fixture value');
  return value;
}

class StateMachineBackend {
  readonly rootIdentities: Record<string, string> = { main: '7:1', second: '7:2', readonly: '8:1' };
  readonly files = new Map<string, { identity: string; bytes: Buffer }>();
  readonly directories = new Set<string>(['main/.', 'second/.', 'readonly/.']);
  readonly deniedReads = new Set<string>();
  readonly vault = new Map<string, { files: [string, { identity: string; bytes: Buffer }][]; directories: string[] }>();
  effects = 0;
  reads = 0;
  lists = 0;
  outcome: 'normal' | 'unknown' | 'denied' | 'invalid' = 'normal';
  private serial = 100;

  seed(path: string, value: string | Buffer, root = 'main'): void {
    this.files.set(`${root}/${path}`, {
      identity: `7:${this.serial++}`, bytes: Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value),
    });
  }

  async invoke(root: string, op: NativeWorkspaceOperation): Promise<NativeWorkspaceReply> {
    const rootIdentity = present(this.rootIdentities[root]);
    const key = `${root}/${op.path}`;
    if (this.deniedReads.has(key) && ['list', 'stat', 'read', 'treeStat'].includes(op.operation)) throw new NativeWorkspaceDeniedError();
    const file = this.files.get(key);
    if (op.operation === 'treeStat') {
      if (!this.directories.has(key)) throw new NativeWorkspaceDeniedError();
      const names = [...this.files].filter(([name]) => name.startsWith(key + '/'))
        .map(([name, value]) => [name.slice(key.length), value.identity, value.bytes.toString('base64')]);
      return { ok: true, rootIdentity, kind: 'directory', identity: '7:90',
        version: createHash('sha256').update(JSON.stringify(names)).digest('hex') };
    }
    if (op.operation === 'stat') {
      if (this.directories.has(key)) return {
        ok: true, rootIdentity, kind: 'directory',
        identity: op.path === '.' ? rootIdentity : '7:90',
      };
      if (!file) throw new NativeWorkspaceDeniedError();
      return { ok: true, rootIdentity, kind: 'file', identity: file.identity, bytes: file.bytes.length };
    }
    if (op.operation === 'read') {
      this.reads++;
      if (!file) throw new NativeWorkspaceDeniedError();
      return { ok: true, rootIdentity, kind: 'file', identity: file.identity,
        bytes: file.bytes.length, base64: file.bytes.toString('base64') };
    }
    if (op.operation === 'list') {
      this.lists++;
      if (!this.directories.has(key)) throw new NativeWorkspaceDeniedError();
      const prefix = root + '/' + (op.path === '.' ? '' : op.path + '/');
      const entries: NonNullable<NativeWorkspaceReply['entries']> = [];
      for (const candidate of this.files.keys()) {
        if (candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/')) {
          entries.push({ name: candidate.slice(prefix.length), type: 'file' });
        }
      }
      for (const candidate of this.directories) {
        const name = candidate.slice(prefix.length);
        if (candidate.startsWith(prefix) && name && name !== '.' && !name.includes('/')) {
          entries.push({ name, type: 'directory' });
        }
      }
      return { ok: true, rootIdentity, entries: entries.sort((a, b) => a.name.localeCompare(b.name)) };
    }
    if (op.operation === 'move' || op.operation === 'trash' || op.operation === 'restore') {
      const isDirectory = op.expectedKind === 'directory';
      if (op.expectedRootIdentity !== rootIdentity) throw new NativeWorkspaceDeniedError();
      if (op.operation === 'restore') {
        const stored = this.vault.get(op.recoveryId);
        if (!stored || this.files.has(key) || this.directories.has(key)) throw new NativeWorkspaceDeniedError();
        for (const [suffix, value] of stored.files) this.files.set(key + suffix, value);
        for (const suffix of stored.directories) this.directories.add(key + suffix);
        this.vault.delete(op.recoveryId);
      } else {
        if (isDirectory ? !this.directories.has(key) : !file || file.identity !== op.expectedFileIdentity || file.bytes.toString('base64') !== op.expectedBase64) throw new NativeWorkspaceDeniedError();
        if (isDirectory) {
          const tree = await this.invoke(root, { operation: 'treeStat', path: op.path });
          if (tree.version !== op.expectedVersion || op.expectedFileIdentity !== '7:90') throw new NativeWorkspaceDeniedError();
        }
        const files = [...this.files].filter(([name]) => name === key || name.startsWith(key + '/'));
        const directories = [...this.directories].filter(name => name === key || name.startsWith(key + '/'));
        if (op.operation === 'trash') this.vault.set(op.recoveryId, {
          files: files.map(([name, value]) => [name.slice(key.length), value]), directories: directories.map(name => name.slice(key.length)),
        });
        else if (op.operation === 'move') {
          const destination = root + '/' + op.destination;
          if (this.files.has(destination) || this.directories.has(destination)) throw new NativeWorkspaceDeniedError();
          for (const [name, value] of files) this.files.set(destination + name.slice(key.length), value);
          for (const name of directories) this.directories.add(destination + name.slice(key.length));
        }
        for (const [name] of files) this.files.delete(name);
        for (const name of directories) this.directories.delete(name);
      }
      this.effects++;
      return { ok: true, rootIdentity };
    }
    if (op.operation !== 'write' && op.operation !== 'mkdir') throw new NativeWorkspaceDeniedError();
    if (op.expectedRootIdentity !== rootIdentity || this.outcome === 'denied') {
      throw new NativeWorkspaceDeniedError();
    }
    if (op.operation === 'mkdir') {
      if (file || this.directories.has(key)) throw new NativeWorkspaceDeniedError();
      this.directories.add(key);
    } else {
      if (op.expectedBase64 === null) {
        if (file || this.directories.has(key) || op.expectedFileIdentity !== null) {
          throw new NativeWorkspaceDeniedError();
        }
      } else if (!file || file.identity !== op.expectedFileIdentity ||
          file.bytes.toString('base64') !== op.expectedBase64) throw new NativeWorkspaceDeniedError();
      this.files.set(key, { identity: file?.identity ?? `7:${this.serial++}`,
        bytes: Buffer.from(op.base64, 'base64') });
    }
    this.effects++;
    if (this.outcome === 'unknown') throw new NativeWorkspaceUnresolvedError();
    if (this.outcome === 'invalid') return { ok: true, rootIdentity: '7:9999' };
    return { ok: true, rootIdentity };
  }
}

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

async function fixture(approval: 'allow' | 'deny' | 'absent' = 'allow', withViewer = true, unattendedRootIds?: readonly string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'owner-workspace-core-'));
  chmodSync(directory, 0o700);
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  // This database is independent of the agent database.
  const db = openDatabase(':memory:');
  cleanup.push(() => db.close());
  const journal = new LocalOperationRepository(db);
  const recovery = new LocalRecoveryStore({ stateDirectory: directory });
  const backend = new StateMachineBackend();
  const challenges: Parameters<NativeOwnerPresenceVerifier>[0][] = [];
  const views: string[] = [];
  const stateMachineOnlyVerifier: NativeOwnerPresenceVerifier = async challenge => {
    challenges.push(challenge);
    return approval === 'allow'
      ? { status: 'VERIFIED', challengeId: challenge.challengeId,
        bindingDigest: challenge.bindingDigest, ownerId: 'synthetic-state-machine-owner',
        verifiedAt: Date.now() }
      : { status: 'DENIED' };
  };
  const consent = approval === 'absent' ? undefined
    : new LocalOwnerConsent({ verifier: stateMachineOnlyVerifier });
  const core = await OwnerWorkspaceCore.create({
    roots: {
      main: { label: 'Main', kind: 'windows-drive', wslPath: '/mnt/c', windowsPath: 'C:\\', writable: true },
      second: { label: 'Second', kind: 'windows-drive', wslPath: '/mnt/c/second',
        windowsPath: 'C:\\second', writable: true },
      readonly: { label: 'Read only', kind: 'wsl-directory', wslPath: '/readonly', writable: false },
    },
    backend, recovery, journal, ...(consent === undefined ? {} : { consent }), redactor: new SecretRedactor(),
    ...(unattendedRootIds === undefined ? {} : { unattendedRootIds }),
    ...(withViewer ? { viewer: { show: async (input: { content: Buffer }) => { views.push(input.content.toString());return { status: approval === 'allow' ? 'DISPLAYED' as const : 'DENIED' as const }; } } } : {}),
  });
  return { core, backend, journal, recovery, db, directory, challenges, views };
}

describe('OwnerWorkspaceCore state-machine-only coordination', () => {
  it('uses trusted root policy for sensitive writes, destructive operations and exact binary export without a verifier', async () => {
    const f = await fixture('deny', false, ['main']);
    const written = await f.core.write({ root: 'main', path: '.env', expectedVersion: null, content: 'PASSWORD=policy-fixture' });
    expect(written.state).toBe('APPLIED');
    const binary = await f.core.readBinary({ root: 'main', path: '.env', expectedVersion: present(written.version) });
    expect(binary.authorizationSource).toBe('trusted-local-policy');
    expect(Buffer.from(binary.base64, 'base64').toString()).toBe('PASSWORD=policy-fixture');
    const moved = await f.core.move({ root: 'main', path: '.env', destination: 'moved.env', expectedVersion: present(written.version) });
    expect(moved.state).toBe('APPLIED');
    const trashed = await f.core.trash({ root: 'main', path: 'moved.env', expectedVersion: present(moved.version) });
    expect(trashed.state).toBe('APPLIED');
    const restored = await f.core.restore({ root: 'main', path: 'moved.env', recoveryId: present(trashed.recoveryId), expectedVersion: null });
    expect(restored.state).toBe('APPLIED');expect(f.challenges).toEqual([]);
    await expect(f.core.reveal({ root: 'main', path: 'moved.env', expectedVersion: present(restored.version) })).rejects.toThrow();
    expect(f.views).toEqual([]);
    const rows = JSON.stringify(f.db.prepare('SELECT * FROM local_workspace_operations').all());
    expect(rows).not.toContain('policy-fixture');expect(rows).not.toContain(binary.base64);
  });
  it('copies trusted policy roots and keeps other roots on the Hello path', async () => {
    const roots = ['main'];const f = await fixture('deny', false, roots);roots.push('second');
    expect((await f.core.write({ root: 'main', path: '.env', expectedVersion: null, content: 'PASSWORD=main-fixture' })).state).toBe('APPLIED');
    expect((await f.core.write({ root: 'second', path: '.env', expectedVersion: null, content: 'PASSWORD=second-fixture' })).state).toBe('DENIED');
    expect(f.challenges.map(c => c.target.rootId)).toEqual(['second']);
  });
  it('revalidates policy-authorized binary bytes and identities before export', async () => {
    const f = await fixture('absent', false, ['main']);f.backend.seed('file', 'before');
    const initial = await f.core.stat({ root: 'main', path: 'file' });
    const invoke = f.backend.invoke.bind(f.backend);let reads = 0;
    f.backend.invoke = async (root, operation) => {
      if (operation.operation === 'read' && ++reads === 2) f.backend.seed('file', 'changed');
      return invoke(root, operation);
    };
    await expect(f.core.readBinary({ root: 'main', path: 'file', expectedVersion: present(initial.version) })).rejects.toThrow();
    expect(reads).toBe(2);expect(f.challenges).toEqual([]);
  });
  it('rejects invalid trusted root lists and untrusted request policy fields', async () => {
    for (const roots of [['*'], ['missing'], ['main', 'main']]) await expect(fixture('absent', false, roots)).rejects.toThrow();
    const f = await fixture('absent', false, ['main']);f.backend.seed('file', 'ordinary');
    const metadata = await f.core.stat({ root: 'main', path: 'file' });
    await expect(f.core.readBinary({ root: 'main', path: 'file', expectedVersion: present(metadata.version),
      unattendedRootIds: ['main'] } as Parameters<typeof f.core.readBinary>[0])).rejects.toThrow();
  });
  it.each(['\r', '\u2028', '\u2029'])('denies unapproved credentials after an ordinary line with separator %#', async ending => {
    const f = await fixture('absent', false);
    const result = await f.core.write({ root: 'main', path: '.env', expectedVersion: null,
      content: `SAFE=visible${ending}PASSWORD=line-ending-private-canary${ending}` });
    expect(result.state).toBe('DENIED');expect(f.backend.files.has('main/.env')).toBe(false);
  });
  it.each(['allow', 'deny', 'absent'] as const)('requires independent consent for newly written CRLF credentials: %s', async approval => {
    const f = await fixture(approval, false);
    const ordinary = await f.core.write({ root: 'main', path: 'ordinary.txt', expectedVersion: null, content: 'ordinary\r\n' });
    expect(ordinary.state).toBe('APPLIED');expect(f.challenges).toEqual([]);
    const result = await f.core.write({ root: 'main', path: '.env', expectedVersion: null, content: 'PASSWORD=crlf-write-private-canary\r\n' });
    expect(result.state).toBe(approval === 'allow' ? 'APPLIED' : 'DENIED');
    expect(f.backend.files.has('main/.env')).toBe(approval === 'allow');
    expect(f.challenges.map(c => c.target.action)).toEqual(approval === 'absent' ? [] : ['credential-write']);
    if (approval === 'allow') {
      const read = await f.core.read({ root: 'main', path: '.env' });
      expect(read.masked).toBe(true);expect(JSON.stringify(read)).not.toContain('private-canary');
    }
  });
  it.each(['allow', 'deny', 'absent'] as const)('keeps independent consent boundaries without a viewer: %s', async approval => {
    const f = await fixture(approval, false);f.backend.seed('.env', 'PASSWORD=viewer-absent-canary\r\n');
    const metadata = await f.core.stat({ root: 'main', path: '.env' });
    const input = { root: 'main', path: '.env', expectedVersion: present(metadata.version) };
    await expect(f.core.reveal(input)).rejects.toThrow();
    expect(f.views).toEqual([]);expect(f.challenges).toEqual([]);
    expect(JSON.stringify(await f.core.read({ root: 'main', path: '.env' }))).not.toContain('viewer-absent-canary');
    const created = await f.core.write({ root: 'main', path: 'ordinary', expectedVersion: null, content: 'ordinary' });
    expect(created.state).toBe('APPLIED');
    if (approval === 'allow') {
      expect((await f.core.readBinary(input)).approvedSnapshot).toBe(true);
    } else {
      await expect(f.core.readBinary(input)).rejects.toThrow();
    }
    const changed = await f.core.write({ ...input, content: 'PASSWORD=replacement-canary' });
    expect(changed.state).toBe(approval === 'allow' ? 'APPLIED' : 'DENIED');
    const trashed = await f.core.trash({ root: 'main', path: 'ordinary', expectedVersion: present(created.version) });
    expect(trashed.state).toBe(approval === 'allow' ? 'APPLIED' : 'DENIED');
    if (approval !== 'absent') {
      expect(f.challenges.map(c => c.target.action)).toEqual(['binary-export', 'credential-write', 'destructive']);
    }
  });
  it('paginates many matching lines without retaining unbounded content or match queues', async () => {
    const f = await fixture();f.backend.seed('many.txt', 'needle\n'.repeat(2500));
    let cursor: string | undefined;let count = 0;
    do {
      const page = await f.core.search({ root: 'main', path: '.', term: 'needle', maxResults: 100, ...(cursor ? { cursor } : {}) });
      count += page.matches.length;cursor = page.cursor ?? undefined;
      const states = (f.core as unknown as { cursors: Map<string, { pending: unknown[] }> }).cursors;
      for (const state of states.values()) expect(state.pending.length).toBeLessThanOrEqual(200);
    } while (cursor);
    expect(count).toBe(2500);
  });
  it('continues a bounded search past inaccessible entries while reporting incomplete coverage', async () => {
    const f = await fixture();f.backend.seed('a-denied', 'private');f.backend.seed('z-visible', 'needle');
    f.backend.directories.add('main/b-private');f.backend.seed('b-private/file', 'private');
    f.backend.deniedReads.add('main/a-denied');f.backend.deniedReads.add('main/b-private');
    const result = await f.core.search({ root: 'main', path: '.', term: 'needle' });
    expect(result.matches).toEqual([expect.objectContaining({ path: 'z-visible', text: 'needle' })]);
    expect(result.incomplete).toBe(true);expect(result.unreadableEntries).toBe(2);
  });
  it('requires native owner confirmation for every recoverable delete, including ordinary files', async () => {
    const f = await fixture('deny');f.backend.seed('public.txt', 'public');
    const view = await f.core.stat({ root: 'main', path: 'public.txt' });
    const result = await f.core.trash({ root: 'main', path: 'public.txt', expectedVersion: present(view.version) });
    expect(result.state).toBe('DENIED');expect(f.backend.files.has('main/public.txt')).toBe(true);
    expect(f.backend.vault.size).toBe(0);expect(f.challenges).toHaveLength(1);
  });
  it('returns honest bounded metadata for a file too large for content operations', async () => {
    const f = await fixture();f.backend.seed('large.bin', Buffer.alloc(2 * 1024 * 1024));
    const result = await f.core.stat({ root: 'main', path: 'large.bin' });
    expect(result).toMatchObject({ kind: 'file', bytes: 2 * 1024 * 1024, version: null, sha256: null, contentLimitBytes: 1024 * 1024 });
    expect(f.backend.reads).toBe(0);
  });
  it('retains the exact durable recovery association when an overwrite applies but its response is lost', async () => {
    const f = await fixture();f.backend.seed('notes', 'original');
    const before = await f.core.stat({ root: 'main', path: 'notes' });
    f.backend.outcome = 'unknown';
    const result = await f.core.write({ root: 'main', path: 'notes', expectedVersion: present(before.version), content: 'changed' });
    expect(result.state).toBe('NEEDS_RECONCILIATION');
    expect(result.recoveryId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(new LocalOperationRepository(f.db).get(result.requestId)).toMatchObject({ state: 'UNRESOLVED', recoveryId: result.recoveryId });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM local_workspace_operations').all())).not.toContain('original');
  });
  it('restores large bounded original preimages even when ordinary new writes have a smaller input limit', async () => {
    const f = await fixture();const original = 'x'.repeat(300 * 1024);f.backend.seed('large.txt', original);
    const before = await f.core.stat({ root: 'main', path: 'large.txt' });
    const changed = await f.core.write({ root: 'main', path: 'large.txt', expectedVersion: present(before.version), content: 'small' });
    expect(changed.state).toBe('APPLIED');
    expect((await f.core.restore({ root: 'main', path: 'large.txt', recoveryId: present(changed.recoveryId), expectedVersion: present(changed.version) })).state).toBe('APPLIED');
    expect(present(f.backend.files.get('main/large.txt')).bytes.toString()).toBe(original);
  });
  it('moves files and whole bounded directory snapshots without overwriting and recovers trash after controller restart', async () => {
    const f = await fixture('allow');f.backend.seed('notes', 'ordinary');
    const stat = await f.core.stat({ root: 'main', path: 'notes' });
    expect((await f.core.move({ root: 'main', path: 'notes', destination: 'renamed', expectedVersion: present(stat.version) })).state).toBe('APPLIED');
    expect(f.backend.files.has('main/notes')).toBe(false);
    const renamed = await f.core.stat({ root: 'main', path: 'renamed' });
    const trashed = await f.core.trash({ root: 'main', path: 'renamed', expectedVersion: present(renamed.version) });
    expect(trashed.state).toBe('APPLIED');expect(f.backend.files.has('main/renamed')).toBe(false);
    const restored = await f.core.restore({ root: 'main', path: 'renamed', expectedVersion: null, recoveryId: present(trashed.recoveryId) });
    expect(restored.state).toBe('APPLIED');expect((await f.core.read({ root: 'main', path: 'renamed' })).content).toBe('ordinary');
    f.backend.directories.add('main/folder');f.backend.seed('folder/.hidden', 'PASSWORD=folder-private-fixture');
    const directory = await f.core.stat({ root: 'main', path: 'folder' });
    expect(directory.version).toMatch(/^[a-f0-9]{64}$/u);
    const treeTrash = await f.core.trash({ root: 'main', path: 'folder', expectedVersion: present(directory.version) });
    expect(treeTrash.state).toBe('APPLIED');expect(f.backend.directories.has('main/folder')).toBe(false);
    expect((await f.core.restore({ root: 'main', path: 'folder', recoveryId: present(treeTrash.recoveryId), expectedVersion: null })).state).toBe('APPLIED');
    expect(f.backend.files.has('main/folder/.hidden')).toBe(true);
    expect(JSON.stringify(treeTrash)).not.toContain('folder-private-fixture');
  });
  it('reveals an approved exact snapshot only to the local viewer and converts both owner path representations', async () => {
    const f = await fixture('allow');f.backend.seed('.env', 'PASSWORD=viewer-local-canary');
    const metadata = await f.core.stat({ root: 'main', path: '.env' });
    const result = await f.core.reveal({ root: 'main', path: '.env', expectedVersion: present(metadata.version) });
    expect(f.views).toEqual(['PASSWORD=viewer-local-canary']);
    expect(result).toEqual({ status: 'DISPLAYED', localOnly: true });
    expect(JSON.stringify(result)).not.toContain('viewer-local-canary');
    expect(await f.core.convertPath({ root: 'main', path: 'source/file.ts', format: 'windows' })).toEqual({ path: 'C:\\source\\file.ts', format: 'windows' });
    expect(await f.core.convertPath({ root: 'main', path: 'source/file.ts', format: 'wsl' })).toEqual({ path: '/mnt/c/source/file.ts', format: 'wsl' });
    await expect(f.core.convertPath({ root: 'main', path: '../escape', format: 'wsl' })).rejects.toThrow();
  });
  it('restores an encrypted overwrite preimage only at its original bound target using live expectedVersion', async () => {
    const f = await fixture();
    const created = await f.core.write({ root: 'main', path: 'notes', expectedVersion: null, content: 'original' });
    const changed = await f.core.write({ root: 'main', path: 'notes', expectedVersion: present(created.version), content: 'changed' });
    const recoveryId = present(changed.recoveryId);
    const result = await f.core.restore({ root: 'main', path: 'notes', recoveryId, expectedVersion: present(changed.version) });
    expect(result.state).toBe('APPLIED');
    expect(result.restored).toBe(true);
    expect((await f.core.read({ root: 'main', path: 'notes' })).content).toBe('original');
    const foreign = await f.core.restore({ root: 'main', path: 'other', recoveryId, expectedVersion: null });
    expect(foreign.state).toBe('DENIED');expect(f.backend.files.has('main/other')).toBe(false);
  });
  it('requires exact-snapshot owner approval for binary export and refuses stale or unapproved exports', async () => {
    const f = await fixture('allow');
    f.backend.seed('image.bin', Buffer.from([0, 255, 1, 7]));
    const view = await f.core.stat({ root: 'main', path: 'image.bin' });
    const exported = await f.core.readBinary({ root: 'main', path: 'image.bin', expectedVersion: present(view.version) });
    expect(exported.base64).toBe('AP8BBw==');
    expect(exported.authorizationSource).toBe('windows-hello');
    expect(f.challenges.at(-1)?.target.action).toBe('binary-export');
    f.backend.seed('image.bin', 'changed');
    await expect(f.core.readBinary({ root: 'main', path: 'image.bin', expectedVersion: present(view.version) })).rejects.toThrow();
    const denied = await fixture('deny');
    denied.backend.seed('image.bin', Buffer.from([0, 255]));
    const deniedView = await denied.core.stat({ root: 'main', path: 'image.bin' });
    await expect(denied.core.readBinary({ root: 'main', path: 'image.bin', expectedVersion: present(deniedView.version) })).rejects.toThrow();
  });

  it('writes canonical bounded binary data with a backup and never includes raw bytes in its receipt', async () => {
    const f = await fixture('allow');
    const created = await f.core.writeBinary({ root: 'main', path: 'image.bin', expectedVersion: null, base64: 'AP8BBw==' });
    expect(created.state).toBe('APPLIED');
    expect(present(f.backend.files.get('main/image.bin')).bytes).toEqual(Buffer.from([0, 255, 1, 7]));
    expect(JSON.stringify(created)).not.toContain('AP8BBw==');
    const overwritten = await f.core.writeBinary({ root: 'main', path: 'image.bin', expectedVersion: present(created.version), base64: 'AQIDAA==' });
    expect(overwritten.recoveryId).toBeDefined();
    await expect(f.core.writeBinary({ root: 'main', path: 'bad.bin', expectedVersion: null, base64: 'not canonical==' })).rejects.toThrow();
  });
  it('creates, overwrites with encrypted recovery, patches uniquely, copies snapshots, and creates directories', async () => {
    const f = await fixture();
    const created = await f.core.write({ root: 'main', path: 'notes.unknown',
      content: 'hello world', expectedVersion: null });
    expect(created.state).toBe('APPLIED');
    expect(created.created).toBe(true);
    expect(created.versionKind).toBe('opaque-hmac-sha256');
    const stat = await f.core.stat({ root: 'main', path: 'notes.unknown' });
    expect(stat.version).toBe(created.version);
    const read = await f.core.read({ root: 'main', path: 'notes.unknown' });
    expect(read.content).toBe('hello world');
    expect(read.version).toBe(created.version);
    expect(read.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(read.sha256).not.toBe(read.version);

    const oldIdentity = present(f.backend.files.get('main/notes.unknown')).identity;
    const overwritten = await f.core.write({ root: 'main', path: 'notes.unknown',
      content: 'hello again', expectedVersion: present(created.version) });
    expect(overwritten.state).toBe('APPLIED');
    expect(overwritten.previousVersion).toBe(created.version);
    expect(overwritten.recoveryId).toBeDefined();
    expect(f.recovery.read(overwritten.recoveryId as string, {
      rootId: 'main', rootIdentity: '7:1', path: 'notes.unknown',
      sourceIdentity: oldIdentity, operation: 'write',
    }).toString()).toBe('hello world');
    const patched = await f.core.patch({ root: 'main', path: 'notes.unknown',
      find: 'again', replacement: 'friend', expectedVersion: present(overwritten.version) });
    expect(patched.state).toBe('APPLIED');
    expect((await f.core.read({ root: 'main', path: 'notes.unknown' })).content).toBe('hello friend');
    const copied = await f.core.copy({ root: 'main', path: 'notes.unknown',
      destination: '.config-copy', expectedVersion: present(patched.version) });
    expect(copied.state).toBe('APPLIED');
    expect(copied.copiedSnapshot).toBe(true);
    expect((await f.core.stat({ root: 'main', path: '.config-copy' })).version).toBe(copied.version);
    expect(copied.version).not.toBe(patched.version);
    f.backend.seed('notes.unknown', 'source changed afterward');
    expect((await f.core.read({ root: 'main', path: '.config-copy' })).content).toBe('hello friend');
    expect((await f.core.mkdir({ root: 'main', path: '.settings' })).state).toBe('APPLIED');
    expect((await f.core.stat({ root: 'main', path: '.settings' })).version).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    'service: {username: alice, password: flow-private-fixture}\n',
    'users:\n  - {username: alice, password: flow-private-fixture}\n',
  ])('withholds YAML flow credentials from preview/search/hash and requires owner consent: %s', async content => {
    const f = await fixture('deny');
    f.backend.seed('settings.yaml', content);
    const read = await f.core.read({ root: 'main', path: 'settings.yaml' });
    expect(read.masked).toBe(true);
    expect(read.content).not.toContain('flow-private-fixture');
    expect(read.sha256).toBeNull();
    expect((await f.core.search({ root: 'main', path: '.', term: 'flow-private-fixture' })).matches).toEqual([]);
    const write = await f.core.write({ root: 'main', path: 'new.yaml', content, expectedVersion: null });
    expect(write.state).toBe('DENIED');
    expect(f.challenges).toHaveLength(1);
    expect(present(f.challenges[0]).target.action).toBe('credential-write');
  });

  it('screens complete .env and structured documents before pagination and search', async () => {
    const f = await fixture();
    const secret = 'state_machine_secret_384987';
    f.backend.seed('.env', `PASSWORD="${secret}\ncontinued-value"\nPUBLIC=visible`);
    f.backend.seed('config.unrecognized', JSON.stringify({ ordinary: 'visible', password: secret }));
    const read = await f.core.read({ root: 'main', path: '.env', startLine: 2, maxLines: 2 });
    expect(read.masked).toBe(true);
    expect(read.sha256).toBeNull();
    expect(read.content).toContain('***REDACTED***');
    expect(read.content).not.toContain('continued-value');
    expect(read.content).not.toContain(secret);
    const structured = await f.core.read({ root: 'main', path: 'config.unrecognized' });
    expect(structured.content).not.toContain(secret);
    expect(structured.sha256).toBeNull();
    expect((await f.core.search({ root: 'main', path: '.', term: secret })).matches).toEqual([]);
    expect((await f.core.search({ root: 'main', path: '.', term: 'continued-value' })).matches).toEqual([]);
    const safe = await f.core.search({ root: 'main', path: '.', term: 'visible' });
    expect(safe.matches.length).toBeGreaterThan(0);
    expect(JSON.stringify(safe)).not.toContain(secret);
    const rows = f.db.prepare('SELECT * FROM local_workspace_operations').all();
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(JSON.stringify(rows)).not.toContain('continued-value');
    expect(JSON.stringify(rows)).not.toContain('.env');
  });

  it('uses fresh state-machine consent for sensitive writes and copies, with masked previews and metadata-only journals', async () => {
    const f = await fixture();
    const secret = 'sensitive_fixture_only_12094';
    const requestId = randomUUID();
    const created = await f.core.write({ root: 'main', path: '.env',
      content: `PASSWORD=${secret}`, expectedVersion: null, requestId });
    expect(created.state).toBe('APPLIED');
    expect(f.challenges).toHaveLength(1);
    expect(present(f.challenges[0]).target.action).toBe('credential-write');
    expect(JSON.stringify(created)).not.toContain(secret);
    const overwritten = await f.core.write({ root: 'main', path: '.env',
      content: 'PUBLIC=ordinary', expectedVersion: present(created.version) });
    expect(overwritten.state).toBe('APPLIED');
    expect(f.challenges).toHaveLength(2);
    expect(overwritten.preview?.before).toContain('***REDACTED***');
    const recoveryDirectory = join(f.directory, 'local-owner-recovery');
    for (const name of readdirSync(recoveryDirectory).filter(name => name.endsWith('.json'))) {
      expect(readFileSync(join(recoveryDirectory, name), 'utf8')).not.toContain(secret);
    }
    f.backend.seed('.credentials', `TOKEN=${secret}`);
    const source = await f.core.stat({ root: 'main', path: '.credentials' });
    const copied = await f.core.copy({ root: 'main', path: '.credentials',
      destination: '.credentials-copy', expectedVersion: present(source.version) });
    expect(copied.state).toBe('APPLIED');
    expect(f.challenges).toHaveLength(3);
    expect(present(f.challenges[2]).target.destination).toBe('.credentials-copy');
    const records = f.db.prepare('SELECT result_json FROM local_workspace_operations').all() as {
      result_json: string | null;
    }[];
    for (const record of records) {
      const result = JSON.parse(record.result_json ?? '{}') as Record<string, unknown>;
      expect(Object.keys(result).every(key =>
        ['version', 'previousVersion', 'recoveryId', 'bytes', 'created'].includes(key))).toBe(true);
    }
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).not.toContain('.credentials');
  });

  it.each(['deny', 'absent'] as const)('denies sensitive mutation when consent is %s', async approval => {
    const f = await fixture(approval);
    const result = await f.core.write({ root: 'main', path: '.env',
      content: 'PASSWORD=fixture-secret', expectedVersion: null });
    expect(result.state).toBe('DENIED');
    expect(f.backend.effects).toBe(0);
    expect(f.journal.get(result.requestId)?.state).toBe('DENIED');
  });

  it('replays metadata without reads, effects, renewed consent, or additional success events', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const input = { root: 'main', path: '.env', content: 'TOKEN=fixture-value',
      expectedVersion: null, requestId } as const;
    const first = await f.core.write(input);
    const effects = f.backend.effects;
    const reads = f.backend.reads;
    const events = f.journal.events(requestId);
    const second = await f.core.write(input);
    expect(second.state).toBe('APPLIED');
    expect(second.version).toBe(first.version);
    expect(second.preview).toBeUndefined();
    expect(f.backend.effects).toBe(effects);
    expect(f.backend.reads).toBe(reads);
    expect(f.challenges).toHaveLength(1);
    expect(f.journal.events(requestId)).toEqual(events);
    await expect(f.core.write({ ...input, content: 'TOKEN=different-fixture' })).rejects.toThrow(
      'Owner workspace operation denied',
    );
    expect(f.backend.effects).toBe(effects);
    expect(f.journal.events(requestId)).toEqual(events);
  });

  it('enforces create-only and version/identity comparisons without replacing existing data', async () => {
    const f = await fixture();
    f.backend.seed('ordinary', 'old');
    const stat = await f.core.stat({ root: 'main', path: 'ordinary' });
    expect((await f.core.write({ root: 'main', path: 'ordinary',
      content: 'new', expectedVersion: null })).state).toBe('DENIED');
    expect((await f.core.write({ root: 'main', path: 'ordinary',
      content: 'new', expectedVersion: '0'.repeat(64) })).state).toBe('DENIED');
    expect((await f.core.patch({ root: 'main', path: 'ordinary',
      find: 'absent', replacement: 'new', expectedVersion: present(stat.version) })).state).toBe('DENIED');
    expect(f.backend.effects).toBe(0);
    expect(present(f.backend.files.get('main/ordinary')).bytes.toString()).toBe('old');
  });

  it('denies read-only roots and traversal while still recording allowed read observations', async () => {
    const f = await fixture();
    f.backend.seed('ordinary', 'readable', 'readonly');
    await expect(f.core.write({ root: 'readonly', path: 'ordinary',
      content: 'changed', expectedVersion: null })).rejects.toThrow();
    for (const path of ['../outside', 'folder/../outside', 'C:/outside', 'folder\\file', 'bad\u0000name']) {
      await expect(f.core.read({ root: 'main', path })).rejects.toThrow();
      await expect(f.core.mkdir({ root: 'main', path })).rejects.toThrow();
    }
    expect((await f.core.read({ root: 'readonly', path: 'ordinary' })).content).toBe('readable');
    await expect(f.core.read({ root: 'main', path: 'missing' })).rejects.toThrow();
    const rows = f.db.prepare("SELECT id,state FROM local_workspace_operations WHERE kind='READ'")
      .all() as { id: string; state: string }[];
    expect(rows.map(row => row.state)).toEqual(['APPLIED', 'DENIED']);
    for (const row of rows) {
      expect(f.journal.events(row.id).map(event => event.state)).toEqual(['OBSERVING', row.state]);
    }
    expect(f.backend.effects).toBe(0);
  });

  it.each(['unknown', 'invalid'] as const)('quarantines %s native outcomes across roots on the same volume', async outcome => {
    const f = await fixture();
    f.backend.outcome = outcome;
    const input = { root: 'main', path: 'uncertain', content: 'snapshot',
      expectedVersion: null, requestId: randomUUID() } as const;
    const result = await f.core.write(input);
    expect(result.state).toBe('NEEDS_RECONCILIATION');
    expect(f.journal.get(input.requestId)?.state).toBe('UNRESOLVED');
    expect(f.backend.effects).toBe(1);
    expect((await f.core.write(input)).state).toBe('NEEDS_RECONCILIATION');
    expect(f.backend.effects).toBe(1);
    await expect(f.core.mkdir({ root: 'second', path: 'blocked' })).rejects.toThrow();
    expect(f.backend.effects).toBe(1);
    // Read observations do not require the mutation volume reservation.
    expect((await f.core.read({ root: 'main', path: 'uncertain' })).content).toBe('snapshot');
  });

  it('reports PREPARED duplicates for reconciliation without dispatching', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const context = { rootId: 'main', rootIdentity: '7:1', path: 'prepared',
      sourceIdentity: null, operation: 'write' } as const;
    f.journal.admit({ id: requestId, kind: 'MUTATION', operation: 'write',
      rootId: 'main', rootIdentity: '7:1', volumeKey: 'windows:7',
      pathFingerprint: f.recovery.pathFingerprint(context),
      bindingDigest: f.recovery.binding(context, Buffer.from(JSON.stringify({
        operation: 'write', path: 'prepared', expectedVersion: null,
        base64: Buffer.from('pending').toString('base64'),
      }))) });
    const result = await f.core.write({ root: 'main', path: 'prepared',
      content: 'pending', expectedVersion: null, requestId });
    expect(result.state).toBe('NEEDS_RECONCILIATION');
    expect(f.backend.effects).toBe(0);
    expect(f.journal.events(requestId).map(event => event.state)).toEqual(['PREPARED']);
  });

  it('requests consent before reporting an invalid sensitive patch and exposes no match oracle on denial', async () => {
    const f = await fixture('deny');
    f.backend.seed('.env', 'PASSWORD=state_machine_secret');
    const snapshot = await f.core.stat({ root: 'main', path: '.env' });
    const absent = await f.core.patch({ root: 'main', path: '.env',
      find: 'not-present', replacement: 'x', expectedVersion: present(snapshot.version) });
    const matched = await f.core.patch({ root: 'main', path: '.env',
      find: 'state_machine_secret', replacement: 'x', expectedVersion: present(snapshot.version) });
    expect(f.challenges).toHaveLength(2);
    expect(absent.state).toBe('DENIED');
    expect(matched.state).toBe('DENIED');
    expect(Object.keys(absent).sort()).toEqual(Object.keys(matched).sort());
    expect(JSON.stringify([absent, matched])).not.toContain('state_machine_secret');
    expect(JSON.stringify([absent, matched])).not.toContain('not-present');
    expect(f.backend.effects).toBe(0);
  });

  it('denies approved nonunique sensitive patches only after the consent state machine runs', async () => {
    const f = await fixture();
    f.backend.seed('.env', 'PASSWORD=fixture\nPUBLIC=repeat repeat');
    const snapshot = await f.core.stat({ root: 'main', path: '.env' });
    const result = await f.core.patch({ root: 'main', path: '.env', find: 'repeat',
      replacement: 'changed', expectedVersion: present(snapshot.version) });
    expect(f.challenges).toHaveLength(1);
    expect(result.state).toBe('DENIED');
    expect(f.backend.effects).toBe(0);
  });

  it('searches beyond 100 entries with bounded work, opaque single-use cursors, and query binding', async () => {
    const f = await fixture();
    for (let index = 0; index < 620; index++) {
      f.backend.seed(`file-${String(index).padStart(4, '0')}.odd`, `needle ${index}`);
    }
    const query = { root: 'main', path: '.', term: 'needle', maxDepth: 0, maxResults: 73 } as const;
    const first = await f.core.search(query);
    expect(first.matches).toHaveLength(73);
    expect(f.backend.lists).toBe(1);
    expect(first.cursor).toMatch(/^[a-f0-9-]{36}$/u);
    await expect(f.core.search({ ...query, term: 'changed', cursor: present(first.cursor) })).rejects.toThrow();
    await expect(f.core.search({ ...query, mode: 'name', cursor: present(first.cursor) })).rejects.toThrow();
    await expect(f.core.search({ ...query, maxDepth: 1, cursor: present(first.cursor) })).rejects.toThrow();
    const names = new Set(first.matches.map(match => match.path));
    let cursor = first.cursor;
    let pages = 1;
    while (cursor !== null) {
      const consumed = cursor;
      const page = await f.core.search({ ...query, cursor });
      expect(page.matches.length).toBeLessThanOrEqual(73);
      expect(page.entriesExamined).toBeLessThanOrEqual(500);
      page.matches.forEach(match => names.add(match.path));
      cursor = page.cursor;
      pages++;
      await expect(f.core.search({ ...query, cursor: consumed })).rejects.toThrow();
      expect(pages).toBeLessThan(20);
    }
    expect(names.size).toBe(620);
    const sparse = await f.core.search({ ...query, term: 'absent' });
    expect(sparse.entriesExamined).toBe(500);
    expect(sparse.matches).toEqual([]);
    expect(sparse.cursor).not.toBeNull();
    const last = await f.core.search({ ...query, term: 'absent', cursor: present(sparse.cursor) });
    expect(last.cursor).toBeNull();
    expect(last.entriesExamined).toBe(120);
  });

  it('expires and caps cursor state, and traverses directories incrementally', async () => {
    const f = await fixture();
    f.backend.directories.add('main/sub');
    f.backend.seed('sub/nested.hidden', 'needle\nneedle');
    const shallow = await f.core.search({ root: 'main', path: '.', term: 'needle', maxDepth: 0 });
    expect(shallow.matches).toEqual([]);
    const deep = await f.core.search({ root: 'main', path: '.', term: 'needle', maxDepth: 1, maxResults: 1 });
    expect(deep.matches).toHaveLength(1);
    const continuation = await f.core.search({
      root: 'main', path: '.', term: 'needle', maxDepth: 1, maxResults: 1, cursor: present(deep.cursor),
    });
    expect(continuation.matches[0]?.line).toBe(2);
    for (let index = 0; index < 63; index++) {
      await f.core.search({ root: 'main', path: '.', term: 'needle', maxDepth: 1, maxResults: 1 });
    }
    await expect(f.core.search({
      root: 'main', path: '.', term: 'needle', maxDepth: 1, maxResults: 1,
    })).rejects.toThrow();
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61_000;
    try {
      await expect(f.core.search({
        root: 'main', path: '.', term: 'needle', maxDepth: 1, maxResults: 1,
        cursor: present(continuation.cursor),
      })).rejects.toThrow();
      expect((await f.core.search({
        root: 'main', path: '.', term: 'needle', maxDepth: 1, maxResults: 1,
      })).matches).toHaveLength(1);
    } finally { Date.now = originalNow; }
  });

  it('bounds text results and rejects invalid UTF-8, NUL, oversized snapshots, and oversized writes', async () => {
    const f = await fixture();
    f.backend.seed('long', 'x'.repeat(40_000) + '\nlast');
    const read = await f.core.read({ root: 'main', path: 'long' });
    expect(read.content).toHaveLength(32_000);
    expect(read.truncated).toBe(true);
    f.backend.seed('invalid', Buffer.from([0xc3, 0x28]));
    f.backend.seed('nul', Buffer.from('a\0b'));
    f.backend.seed('oversized', Buffer.alloc(1024 * 1024 + 1));
    for (const path of ['invalid', 'nul', 'oversized']) {
      await expect(f.core.read({ root: 'main', path })).rejects.toThrow();
    }
    const binaryStat = await f.core.stat({ root: 'main', path: 'invalid' });
    expect(binaryStat.version).toMatch(/^[a-f0-9]{64}$/u);
    expect(binaryStat.sha256).toBeNull();
    await expect(f.core.write({ root: 'main', path: 'too-large',
      content: 'x'.repeat(256 * 1024 + 1), expectedVersion: null })).rejects.toThrow();
    expect(f.backend.effects).toBe(0);
  });

  it('rejects changed pinned root identities and records observation denial', async () => {
    const f = await fixture();
    f.backend.seed('ordinary', 'visible');
    f.backend.rootIdentities.main = '7:999';
    await expect(f.core.read({ root: 'main', path: 'ordinary' })).rejects.toThrow();
    const states = f.db.prepare('SELECT state FROM local_workspace_operations').all();
    expect(states).toEqual([{ state: 'DENIED' }]);
    expect(f.backend.effects).toBe(0);
  });
});
