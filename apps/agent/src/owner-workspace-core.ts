import { createHash, randomUUID } from 'node:crypto';
import type { SecretRedactor } from '@gram/secrets';
import type {
  LocalOperationRecord,
  LocalOperationRepository,
  LocalOperationResult,
} from '@gram/persistence';
import type { LocalOwnerConsent, LocalOwnerOperation } from './local-owner-consent.js';
import type { LocalRecoveryStore, RecoveryContext } from './local-recovery-store.js';
import type { WindowsProtectedLocalViewer } from './windows-owner-consent-verifier.js';
import { screenLocalText } from './local-content-screen.js';
import { NativeWorkspaceDeniedError } from './windows-workspace-client.js';
import type {
  NativeWorkspaceOperation,
  NativeWorkspaceReply,
  WindowsWorkspaceClient,
} from './windows-workspace-client.js';

export interface OwnerWorkspaceRoot {
  label: string;
  kind: 'windows-drive' | 'wsl-directory';
  wslPath: string;
  windowsPath?: string;
  writable: boolean;
}

export interface OwnerWorkspaceOptions {
  roots: Record<string, OwnerWorkspaceRoot>;
  backend: Pick<WindowsWorkspaceClient, 'invoke'>;
  recovery: LocalRecoveryStore;
  journal: LocalOperationRepository;
  consent?: LocalOwnerConsent;
  viewer?: WindowsProtectedLocalViewer;
  redactor: SecretRedactor;
}

interface Target { root: string; path: string }
interface MutationTarget extends Target { requestId?: string | undefined }
interface VersionedTarget extends MutationTarget { expectedVersion: string | null }
interface WriteInput extends VersionedTarget { content: string }
interface PatchInput extends MutationTarget {
  find: string;
  replacement: string;
  expectedVersion: string;
}
interface CopyInput extends MutationTarget { destination: string; expectedVersion: string }
interface SearchInput extends Target {
  term: string;
  maxDepth?: number | undefined;
  maxResults?: number | undefined;
  mode?: 'text' | 'name' | undefined;
  cursor?: string | undefined;
}
interface Snapshot {
  bytes: Buffer;
  identity: string;
  version: string;
  text: string | null;
  screened: string | null;
  sensitive: boolean;
  sha256: string | null;
}
type MovingSnapshot = { kind: 'file'; snapshot: Snapshot; identity: string; version: string }
  | { kind: 'directory'; nativeVersion: string; identity: string; version: string };
interface SearchMatch { path: string; line?: number; text: string; truncated: boolean }
interface SearchState {
  binding: string;
  expiresAt: number;
  stack: { path: string; depth: number; offset: number }[];
  pending: SearchMatch[];
  scan?: { path: string; nextLine: number; version: string };
  unreadable: number;
}
type MutationResult = LocalOperationResult & {
  requestId: string;
  state: 'APPLIED' | 'DENIED' | 'NEEDS_RECONCILIATION';
  versionKind?: 'opaque-hmac-sha256';
  copiedSnapshot?: boolean;
  preview?: { before: string | null; after: string | null; truncated: boolean };
};

const FILE_LIMIT = 1024 * 1024;
const WRITE_LIMIT = 256 * 1024;
const TEXT_LIMIT = 32_000;
const VERSION_KIND = 'opaque-hmac-sha256' as const;
const IDENTITY = /^\d+:\d+$/u;
const VERSION = /^[a-f0-9]{64}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const denied = () => new Error('Owner workspace operation denied');

function shape(value: unknown, required: string[], optional: string[] = []): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw denied();
}

function path(value: unknown, root = false): asserts value is string {
  if (root && value === '.') return;
  if (typeof value !== 'string' || !value || value.length > 2048 ||
      /[\\:<>"|?*]/u.test(value) || Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      value.split('/').length > 60 ||
      value.split('/').some(part => !part || part === '.' || part === '..' ||
        part.endsWith('.') || part.endsWith(' '))) throw denied();
}

function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw denied();
  return result;
}

function text(bytes: Buffer): string | null {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return decoded.includes('\0') ? null : decoded;
  } catch { return null; }
}

function content(value: unknown): Buffer {
  if (typeof value !== 'string' || value.includes('\0')) throw denied();
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > WRITE_LIMIT || bytes.toString('utf8') !== value) throw denied();
  return bytes;
}

function expected(value: unknown, nullable = false): void {
  if (!(nullable && value === null) && (typeof value !== 'string' || !VERSION.test(value))) throw denied();
}

/**
 * Bounded controller logic only. Native containment, native owner presence, and
 * deployment composition remain separate responsibilities of the injected ports.
 * Reads and multi-page searches are observations, not filesystem transactions.
 */
export class OwnerWorkspaceCore {
  private readonly configured: Record<string, Readonly<OwnerWorkspaceRoot>>;
  private readonly identities = new Map<string, string>();
  private readonly cursors = new Map<string, SearchState>();

  private constructor(private readonly options: OwnerWorkspaceOptions) {
    this.configured = Object.fromEntries(Object.entries(options.roots)
      .map(([id, root]) => [id, Object.freeze({ ...root })]));
  }

  static async create(options: OwnerWorkspaceOptions): Promise<OwnerWorkspaceCore> {
    const entries = Object.entries(options.roots);
    if (!entries.length || entries.length > 26) throw denied();
    for (const [id, root] of entries) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id) ||
          typeof root.label !== 'string' || root.label.length > 256 ||
          !['windows-drive', 'wsl-directory'].includes(root.kind) ||
          typeof root.wslPath !== 'string' || !root.wslPath ||
          (root.windowsPath !== undefined && typeof root.windowsPath !== 'string') ||
          typeof root.writable !== 'boolean') throw denied();
    }
    const core = new OwnerWorkspaceCore(options);
    for (const [id] of entries) {
      const reply = await options.backend.invoke(id, { operation: 'stat', path: '.' });
      if (reply.ok !== true || reply.kind !== 'directory' ||
          !IDENTITY.test(reply.rootIdentity) || reply.identity !== reply.rootIdentity) throw denied();
      core.identities.set(id, reply.rootIdentity);
    }
    return core;
  }

  roots(): { id: string; label: string; kind: OwnerWorkspaceRoot['kind']; writable: boolean }[] {
    return Object.entries(this.configured).map(([id, root]) => ({
      id, label: this.mask(root.label), kind: root.kind, writable: root.writable,
    }));
  }

  private target(input: Target, allowRoot = false): void {
    if (typeof input.root !== 'string' || !Object.hasOwn(this.configured, input.root)) throw denied();
    path(input.path, allowRoot);
  }

  private rootIdentity(root: string): string {
    const identity = this.identities.get(root);
    if (!identity) throw denied();
    return identity;
  }

  private context(input: Target, operation: RecoveryContext['operation'] = 'write',
    sourceIdentity: string | null = null): RecoveryContext {
    // Recovery contexts require a non-root relative path. This sentinel is used
    // only for directory observations; file content versions use the exact path.
    return { rootId: input.root, rootIdentity: this.rootIdentity(input.root),
      path: input.path === '.' ? '$root-observation' : input.path, sourceIdentity, operation };
  }

  private mask(value: string): string {
    return screenLocalText(value, this.options.redactor).content;
  }

  private async invoke(root: string, operation: NativeWorkspaceOperation): Promise<NativeWorkspaceReply> {
    const reply = await this.options.backend.invoke(root, operation);
    if (!reply || reply.ok !== true || reply.rootIdentity !== this.identities.get(root)) throw denied();
    return reply;
  }

  private async snapshot(input: Target): Promise<Snapshot> {
    const reply = await this.invoke(input.root, { operation: 'read', path: input.path });
    if (reply.kind !== 'file' || typeof reply.identity !== 'string' || !IDENTITY.test(reply.identity) ||
        typeof reply.base64 !== 'string' || reply.base64.length > Math.ceil(FILE_LIMIT / 3) * 4) throw denied();
    const bytes = Buffer.from(reply.base64, 'base64');
    if (bytes.length > FILE_LIMIT || bytes.toString('base64') !== reply.base64 || bytes.length !== reply.bytes) throw denied();
    const decoded = text(bytes);
    const screened = decoded === null ? null : screenLocalText(decoded, this.options.redactor);
    return {
      bytes, identity: reply.identity,
      version: this.options.recovery.version(this.context(input), bytes),
      text: decoded, screened: screened?.content ?? null,
      sensitive: screened === null || screened.masked,
      sha256: screened !== null && !screened.masked
        ? createHash('sha256').update(bytes).digest('hex') : null,
    };
  }

  private admit(input: Target, operation: string, intent: unknown, mutation: boolean, id: string = randomUUID()) {
    const context = this.context(input);
    const root = this.configured[input.root] ?? (() => {throw denied();})();
    return this.options.journal.admit({
      id, kind: mutation ? 'MUTATION' : 'READ', operation,
      rootId: input.root, rootIdentity: context.rootIdentity,
      volumeKey: `${root.kind === 'windows-drive' ? 'windows' : 'linux'}:${context.rootIdentity.split(':')[0]}`,
      pathFingerprint: this.options.recovery.pathFingerprint(context),
      bindingDigest: this.options.recovery.binding(context, Buffer.from(JSON.stringify(intent))),
    });
  }

  private async observe<T>(input: Target, operation: string, intent: unknown,
    run: () => Promise<T>): Promise<T> {
    let id: string;
    try { id = this.admit(input, operation, intent, false).operation.id; }
    catch { throw denied(); }
    try {
      const result = await run();
      this.options.journal.finish(id, 'APPLIED', {});
      return result;
    } catch {
      this.options.journal.finish(id, 'DENIED', {});
      throw denied();
    }
  }

  async list(input: Target & { offset?: number | undefined; limit?: number | undefined }) {
    shape(input, ['root', 'path'], ['offset', 'limit']);
    this.target(input, true);
    const offset = integer(input.offset, 0, 0, 10_000);
    const limit = integer(input.limit, 100, 1, 100);
    return this.observe(input, 'list', { path: input.path, offset, limit }, async () => {
      const entries = await this.entries(input);
      return { entries: entries.slice(offset, offset + limit).map(entry => ({
        name: this.mask(entry.name).slice(0, 255), type: entry.type,
      })), offset, truncated: offset + limit < entries.length,
      nextOffset: offset + limit < entries.length ? offset + limit : null };
    });
  }

  private async entries(input: Target) {
    const reply = await this.invoke(input.root, { operation: 'list', path: input.path });
    if (!Array.isArray(reply.entries) || reply.entries.length > 10_000) throw denied();
    for (const entry of reply.entries) {
      if (!entry || typeof entry.name !== 'string' || entry.name.length > 255 ||
          entry.name.includes('/') || !['file', 'directory', 'symlink'].includes(entry.type)) throw denied();
      path(entry.name);
    }
    return [...reply.entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  }

  async stat(input: Target) {
    shape(input, ['root', 'path']);
    this.target(input, true);
    return this.observe(input, 'stat', { path: input.path }, async () => {
      const reply = await this.invoke(input.root, { operation: 'stat', path: input.path });
      if (typeof reply.identity !== 'string' || !IDENTITY.test(reply.identity)) throw denied();
      if (reply.kind === 'directory') {
        if (input.path === '.') return { kind: 'directory' as const, version: null, sha256: null };
        const tree = await this.movingSnapshot(input);
        return { kind: 'directory' as const, version: tree.version, versionKind: VERSION_KIND,
          sha256: null, snapshotOnly: true };
      }
      if (reply.kind !== 'file') throw denied();
      if (Number.isSafeInteger(reply.bytes) && Number(reply.bytes) > FILE_LIMIT) return {
        kind: 'file' as const, bytes: reply.bytes, version: null, sha256: null, contentLimitBytes: FILE_LIMIT,
      };
      const snapshot = await this.snapshot(input);
      if (snapshot.identity !== reply.identity) throw denied();
      return { kind: 'file' as const, bytes: snapshot.bytes.length, version: snapshot.version,
        versionKind: VERSION_KIND, sha256: snapshot.sha256, masked: snapshot.sensitive };
    });
  }

  async read(input: Target & { startLine?: number | undefined; maxLines?: number | undefined }) {
    shape(input, ['root', 'path'], ['startLine', 'maxLines']);
    this.target(input);
    const startLine = integer(input.startLine, 1, 1, FILE_LIMIT + 1);
    const maxLines = integer(input.maxLines, 200, 1, 200);
    return this.observe(input, 'read', { path: input.path, startLine, maxLines }, async () => {
      const snapshot = await this.snapshot(input);
      if (snapshot.screened === null) throw denied();
      const lines = snapshot.screened.split('\n');
      const selected = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
      return { content: selected.slice(0, TEXT_LIMIT), startLine, version: snapshot.version,
        versionKind: VERSION_KIND, sha256: snapshot.sha256, masked: snapshot.sensitive,
        truncated: selected.length > TEXT_LIMIT || startLine - 1 + maxLines < lines.length };
    });
  }

  async search(input: SearchInput) {
    shape(input, ['root', 'path', 'term'], ['maxDepth', 'maxResults', 'mode', 'cursor']);
    this.target(input, true);
    if (typeof input.term !== 'string' || !input.term || input.term.length > 1024 ||
        Array.from(input.term).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) throw denied();
    const maxDepth = integer(input.maxDepth, 5, 0, 60);
    const maxResults = integer(input.maxResults, 100, 1, 100);
    const mode = input.mode ?? 'text';
    if (!['text', 'name'].includes(mode) ||
        (input.cursor !== undefined && (typeof input.cursor !== 'string' || !UUID.test(input.cursor)))) throw denied();
    const query = { root: input.root, path: input.path, term: input.term, mode, maxDepth, maxResults };
    const binding = this.options.recovery.binding(this.context(input), Buffer.from(JSON.stringify(query)));
    for (const [id, state] of this.cursors) {
      if (state.expiresAt <= Date.now()) this.cursors.delete(id);
    }
    let state: SearchState;
    if (input.cursor !== undefined) {
      const stored = this.cursors.get(input.cursor);
      if (!stored || stored.binding !== binding) throw denied();
      this.cursors.delete(input.cursor);
      state = stored;
    } else {
      if (this.cursors.size >= 64) throw denied();
      state = { binding, expiresAt: Date.now() + 60_000,
        stack: [{ path: input.path, depth: 0, offset: 0 }], pending: [], unreadable: 0 };
    }
    return this.observe(input, 'search', { ...query, cursor: input.cursor ?? null }, async () => {
      const matches: SearchMatch[] = [];
      let work = 0;
      let remaining = TEXT_LIMIT;
      const listings = new Map<string, NonNullable<NativeWorkspaceReply['entries']>>();
      let cachedEntries = 0;
      const queueLines = (snapshot: Snapshot, child: string, start: number) => {
        if (snapshot.screened === null) { delete state.scan;return; }
        const lines = snapshot.screened.split('\n');
        let index = start;
        while (index < lines.length && state.pending.length < 200) {
          const line = lines[index] ?? '';
          if (line.includes(input.term)) state.pending.push({ path: this.mask(child), line: index + 1,
            text: line.slice(0, TEXT_LIMIT), truncated: line.length > TEXT_LIMIT });
          index++;
        }
        if (index < lines.length) state.scan = { path: child, nextLine: index, version: snapshot.version };
        else delete state.scan;
      };
      while (matches.length < maxResults && remaining > 0) {
        const pending = state.pending[0];
        if (pending) {
          state.pending.shift();
          const displayedPath = pending.path.slice(0, remaining);
          remaining -= displayedPath.length;
          const displayedText = pending.text.slice(0, remaining);
          remaining -= displayedText.length;
          matches.push({ ...pending, path: displayedPath, text: displayedText,
            truncated: pending.truncated || displayedText.length !== pending.text.length ||
              displayedPath.length !== pending.path.length });
          continue;
        }
        if (work >= 500) break;
        if (state.scan) {
          const scan = state.scan;work++;
          try {
            const snapshot = await this.snapshot({ root: input.root, path: scan.path });
            if (snapshot.version !== scan.version) { state.unreadable++;delete state.scan; }
            else queueLines(snapshot, scan.path, scan.nextLine);
          } catch (error) {
            if (!(error instanceof NativeWorkspaceDeniedError)) throw error;
            state.unreadable++;delete state.scan;
          }
          continue;
        }
        const frame = state.stack.at(-1);
        if (!frame) break;
        let entries: NonNullable<NativeWorkspaceReply['entries']>;
        try {
          const cached = listings.get(frame.path);
          if (cached !== undefined) entries = cached;
          else {
            entries = await this.entries({ root: input.root, path: frame.path });
            // Reuse this request's directory observation, with a total bounded cache.
            while (cachedEntries + entries.length > 10_000 && listings.size > 0) {
              const oldest = listings.keys().next().value;
              if (oldest === undefined) throw denied();
              cachedEntries -= listings.get(oldest)?.length ?? 0;listings.delete(oldest);
            }
            listings.set(frame.path, entries);cachedEntries += entries.length;
          }
        }
        catch (error) {
          if (!(error instanceof NativeWorkspaceDeniedError)) throw error;
          state.unreadable++;state.stack.pop();work++;continue;
        }
        const entry = entries[frame.offset++];
        if (!entry) { state.stack.pop(); continue; }
        work++;
        const child = frame.path === '.' ? entry.name : `${frame.path}/${entry.name}`;
        path(child);
        if (entry.type === 'directory' && frame.depth < maxDepth) {
          state.stack.push({ path: child, depth: frame.depth + 1, offset: 0 });
        }
        if (mode === 'name') {
          const name = this.mask(entry.name);
          if (name.includes(input.term)) state.pending.push({
            path: this.mask(child), text: name, truncated: false,
          });
        } else if (entry.type === 'file') {
          try { queueLines(await this.snapshot({ root: input.root, path: child }), child, 0); }
          catch (error) {
            if (!(error instanceof NativeWorkspaceDeniedError)) throw error;
            state.unreadable++;
          }
        }
      }
      const truncated = state.pending.length > 0 || state.stack.length > 0 || state.scan !== undefined;
      let cursor: string | null = null;
      if (truncated) {
        if (this.cursors.size >= 64) throw denied();
        cursor = randomUUID();
        // Lifetime is measured from the initial query, not refreshed per page.
        if (state.expiresAt <= Date.now()) throw denied();
        this.cursors.set(cursor, state);
      }
      return { matches, cursor, truncated, entriesExamined: work,
        incomplete: state.unreadable > 0, unreadableEntries: state.unreadable };
    });
  }

  private replay(record: LocalOperationRecord): MutationResult {
    return { ...(record.resultJson === null ? {} : JSON.parse(record.resultJson) as LocalOperationResult),
      requestId: record.id, ...(record.recoveryId === null ? {} : { recoveryId: record.recoveryId }),
      state: record.state === 'PREPARED' || record.state === 'UNRESOLVED'
        ? 'NEEDS_RECONCILIATION' : record.state === 'APPLIED' ? 'APPLIED' : 'DENIED',
      ...(record.state === 'APPLIED' && record.operation !== 'mkdir' ? { versionKind: VERSION_KIND } : {}),
      ...(record.operation === 'copy' && record.state === 'APPLIED' ? { copiedSnapshot: true } : {}) };
  }

  private async mutate(input: MutationTarget, operation: 'write' | 'patch' | 'mkdir' | 'copy' | 'binary-write' | 'restore' | 'move' | 'trash',
    intent: unknown, run: (id: string, dispatch: (op: NativeWorkspaceOperation) => Promise<void>) =>
      Promise<{ metadata: LocalOperationResult; preview?: MutationResult['preview'] }>): Promise<MutationResult> {
    this.target(input);
    if (!this.configured[input.root]?.writable ||
        (input.requestId !== undefined && !UUID.test(input.requestId))) throw denied();
    let admitted: ReturnType<OwnerWorkspaceCore['admit']>;
    try { admitted = this.admit(input, operation, intent, true, input.requestId ?? randomUUID()); }
    catch { throw denied(); }
    if (!admitted.created) return this.replay(admitted.operation);
    const id = admitted.operation.id;
    let dispatched = false;
    try {
      const result = await run(id, async op => {
        dispatched = true;
        const reply = await this.invoke(input.root, op);
        if (reply.identity !== undefined && !IDENTITY.test(reply.identity)) throw denied();
      });
      this.options.journal.finish(id, 'APPLIED', result.metadata);
      return { ...result.metadata, requestId: id, state: 'APPLIED',
        ...(operation !== 'mkdir' ? { versionKind: VERSION_KIND } : {}),
        ...(operation === 'copy' ? { copiedSnapshot: true } : {}),
        ...(result.preview ? { preview: result.preview } : {}) };
    } catch (error) {
      const state = dispatched && !(error instanceof NativeWorkspaceDeniedError) ? 'UNRESOLVED' : 'DENIED';
      // A failed journal commit after dispatch must never produce a success reply.
      if (this.options.journal.get(id)?.state === 'PREPARED') this.options.journal.finish(id, state, {});
      const recoveryId = this.options.journal.get(id)?.recoveryId;
      return { requestId: id, state: state === 'UNRESOLVED' ? 'NEEDS_RECONCILIATION' : 'DENIED',
        ...(recoveryId ? { recoveryId } : {}) };
    }
  }

  private async authorize(id: string, target: Target, old: Snapshot | null, bytes: Buffer,
    source?: { target: Target; snapshot: Snapshot }): Promise<void> {
    const screened = text(bytes);
    const sensitive = old?.sensitive || source?.snapshot.sensitive ||
      screened === null || screenLocalText(screened, this.options.redactor).masked;
    if (!sensitive) return;
    if (!this.options.consent) throw denied();
    const subject = source?.target ?? target;
    const preimage = source?.snapshot ?? old;
    const operation: LocalOwnerOperation = {
      taskId: id, action: 'credential-write', rootId: subject.root,
      rootIdentity: this.rootIdentity(subject.root), path: subject.path,
      fileIdentity: preimage?.identity ?? null, targetState: preimage ? 'EXISTING' : 'ABSENT',
      preimageDigest: preimage?.version ?? null,
      postimageDigest: this.options.recovery.version(this.context(target), bytes),
      destination: source ? target.path : null,
      destinationRootIdentity: source ? this.rootIdentity(target.root) : null,
    };
    const grant = await this.options.consent.request(operation);
    if (!grant) throw denied();
    if (preimage) {
      const live = await this.snapshot(subject);
      if (live.identity !== preimage.identity || !live.bytes.equals(preimage.bytes)) throw denied();
    } else {
      const live = await this.invoke(target.root, { operation: 'stat', path: '.' });
      if (live.kind !== 'directory' || live.identity !== this.identities.get(target.root)) throw denied();
    }
    if (!this.options.consent.consume(grant.capability, operation)) throw denied();
  }

  private preview(old: Snapshot | null, bytes: Buffer): MutationResult['preview'] {
    const decoded = text(bytes);
    const before = old?.screened ?? null;
    const after = decoded === null ? null : this.mask(decoded);
    return { before: before?.slice(0, TEXT_LIMIT / 2) ?? null,
      after: after?.slice(0, TEXT_LIMIT / 2) ?? null,
      truncated: (before?.length ?? 0) > TEXT_LIMIT / 2 || (after?.length ?? 0) > TEXT_LIMIT / 2 };
  }

  private async replace(operationId: string, input: Target, old: Snapshot | null, bytes: Buffer,
    operation: 'write' | 'copy', dispatch: (op: NativeWorkspaceOperation) => Promise<void>) {
    const context = this.context(input, operation, old?.identity ?? null);
    const recovery = old ? this.options.recovery.capture(context, old.bytes) : undefined;
    if (recovery) this.options.journal.attachRecovery(operationId, recovery.recoveryId);
    await dispatch({ operation: 'write', path: input.path,
      expectedRootIdentity: context.rootIdentity, expectedFileIdentity: old?.identity ?? null,
      expectedBase64: old?.bytes.toString('base64') ?? null, base64: bytes.toString('base64') });
    return { metadata: {
      version: this.options.recovery.version(context, bytes), previousVersion: old?.version ?? null,
      bytes: bytes.length, created: old === null, ...(recovery ?? {}),
    }, preview: this.preview(old, bytes) };
  }

  async write(input: WriteInput): Promise<MutationResult> {
    shape(input, ['root', 'path', 'content', 'expectedVersion'], ['requestId']);
    this.target(input);
    expected(input.expectedVersion, true);
    const bytes = content(input.content);
    return this.mutate(input, 'write', { operation: 'write', path: input.path,
      expectedVersion: input.expectedVersion, base64: bytes.toString('base64') }, async (id, dispatch) => {
      const old = input.expectedVersion === null ? null : await this.snapshot(input);
      if (old && old.version !== input.expectedVersion) throw denied();
      await this.authorize(id, input, old, bytes);
      return this.replace(id, input, old, bytes, 'write', dispatch);
    });
  }

  async readBinary(input: Target & { expectedVersion: string }) {
    shape(input, ['root', 'path', 'expectedVersion']);
    this.target(input);expected(input.expectedVersion);
    return this.observe(input, 'binary-read', { path: input.path, expectedVersion: input.expectedVersion }, async () => {
      const snapshot = await this.snapshot(input);
      if (snapshot.version !== input.expectedVersion || !this.options.consent) throw denied();
      const operation: LocalOwnerOperation = {
        taskId: randomUUID(), action: 'binary-export', rootId: input.root,
        rootIdentity: this.rootIdentity(input.root), path: input.path,
        fileIdentity: snapshot.identity, targetState: 'EXISTING',
        preimageDigest: snapshot.version, postimageDigest: null,
        destination: null, destinationRootIdentity: null,
      };
      const grant = await this.options.consent.request(operation);
      if (!grant) throw denied();
      const current = await this.snapshot(input);
      if (current.identity !== snapshot.identity || !current.bytes.equals(snapshot.bytes) ||
          !this.options.consent.consume(grant.capability, operation)) throw denied();
      return { base64: snapshot.bytes.toString('base64'), bytes: snapshot.bytes.length,
        version: snapshot.version, versionKind: VERSION_KIND, approvedSnapshot: true };
    });
  }

  async reveal(input: Target & { expectedVersion: string }) {
    shape(input, ['root', 'path', 'expectedVersion']);
    this.target(input);expected(input.expectedVersion);
    return this.observe(input, 'reveal', { path: input.path, expectedVersion: input.expectedVersion }, async () => {
      const snapshot = await this.snapshot(input);
      if (snapshot.version !== input.expectedVersion || snapshot.text === null ||
          snapshot.bytes.length > WRITE_LIMIT || !this.options.viewer) throw denied();
      const current = await this.snapshot(input);
      if (current.identity !== snapshot.identity || !current.bytes.equals(snapshot.bytes)) throw denied();
      const result = await this.options.viewer.show({ target: {
        action: 'protected-reveal', rootId: input.root, path: input.path, destination: null,
      }, content: Buffer.from(snapshot.bytes) });
      if (result.status !== 'DISPLAYED') throw denied();
      return { status: 'DISPLAYED' as const, localOnly: true };
    });
  }

  async convertPath(input: Target & { format: 'windows' | 'wsl' }) {
    shape(input, ['root', 'path', 'format']);this.target(input, true);
    const root = this.configured[input.root];
    if (!root || !['windows', 'wsl'].includes(input.format)) throw denied();
    const base = input.format === 'windows' ? root.windowsPath : root.wslPath;
    if (!base) throw denied();
    return this.observe(input, 'convert-path', { path: input.path, format: input.format }, async () => {
      const separator = input.format === 'windows' ? '\\' : '/';
      return { path: input.path === '.' ? base : base.replace(/[\\/]+$/u, '') + separator +
        input.path.split('/').join(separator), format: input.format };
    });
  }

  async writeBinary(input: VersionedTarget & { base64: string }): Promise<MutationResult> {
    shape(input, ['root', 'path', 'base64', 'expectedVersion'], ['requestId']);
    this.target(input);expected(input.expectedVersion, true);
    if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(WRITE_LIMIT / 3) * 4) throw denied();
    const bytes = Buffer.from(input.base64, 'base64');
    if (bytes.length > WRITE_LIMIT || bytes.toString('base64') !== input.base64) throw denied();
    return this.mutate(input, 'binary-write', { operation: 'binary-write', path: input.path,
      expectedVersion: input.expectedVersion, base64: input.base64 }, async (id, dispatch) => {
      const old = input.expectedVersion === null ? null : await this.snapshot(input);
      if (old && old.version !== input.expectedVersion) throw denied();
      await this.authorize(id, input, old, bytes);
      const result = await this.replace(id, input, old, bytes, 'write', dispatch);
      return { metadata: result.metadata };
    });
  }

  async restore(input: VersionedTarget & { recoveryId: string }): Promise<MutationResult> {
    shape(input, ['root', 'path', 'recoveryId', 'expectedVersion'], ['requestId']);
    this.target(input);expected(input.expectedVersion, true);
    if (!UUID.test(input.recoveryId)) throw denied();
    return this.mutate(input, 'restore', { operation: 'restore', path: input.path,
      recoveryId: input.recoveryId, expectedVersion: input.expectedVersion }, async (id, dispatch) => {
      const record = this.options.recovery.readForTarget(input.recoveryId, {
        rootId: input.root, rootIdentity: this.rootIdentity(input.root), path: input.path,
      });
      if (record.context.operation === 'trash') {
        if (input.expectedVersion !== null) throw denied();
        const value: unknown = JSON.parse(record.bytes.toString('utf8'));
        if (value === null || typeof value !== 'object' || Array.isArray(value)) throw denied();
        const descriptor = value as Record<string, unknown>;
        if (!['file', 'directory'].includes(String(descriptor.kind)) || typeof descriptor.identity !== 'string' ||
            !IDENTITY.test(descriptor.identity) || typeof descriptor.vaultId !== 'string' || !UUID.test(descriptor.vaultId) ||
            descriptor.identity !== record.context.sourceIdentity) throw denied();
        let original: MovingSnapshot;
        if (descriptor.kind === 'directory') {
          if (typeof descriptor.nativeVersion !== 'string' || !VERSION.test(descriptor.nativeVersion)) throw denied();
          original = { kind: 'directory', identity: descriptor.identity, nativeVersion: descriptor.nativeVersion,
            version: this.directoryVersion(input, descriptor.identity, descriptor.nativeVersion) };
        } else {
          if (typeof descriptor.base64 !== 'string' || descriptor.base64.length > Math.ceil(FILE_LIMIT / 3) * 4) throw denied();
          const bytes = Buffer.from(descriptor.base64, 'base64');
          if (bytes.length > FILE_LIMIT || bytes.toString('base64') !== descriptor.base64) throw denied();
          const decoded = text(bytes);const screened = decoded === null ? null : screenLocalText(decoded, this.options.redactor);
          const snapshot: Snapshot = { bytes, identity: descriptor.identity,
            version: this.options.recovery.version(this.context(input), bytes), text: decoded,
            screened: screened?.content ?? null, sensitive: screened === null || screened.masked, sha256: null };
          original = { kind: 'file', snapshot, identity: snapshot.identity, version: snapshot.version };
        }
        await this.authorizeMoving(id, input, original, undefined, false);
        await dispatch({ operation: 'restore', path: input.path, recoveryId: descriptor.vaultId,
          expectedRootIdentity: this.rootIdentity(input.root), ...this.nativePreimage(original) });
        return { metadata: { restored: true, version: original.version, recoveryId: input.recoveryId } };
      }
      if (!['write', 'copy', 'restore'].includes(record.context.operation) || record.bytes.length > FILE_LIMIT) throw denied();
      const old = input.expectedVersion === null ? null : await this.snapshot(input);
      if (old && old.version !== input.expectedVersion) throw denied();
      await this.authorize(id, input, old, record.bytes);
      const result = await this.replace(id, input, old, record.bytes, 'write', dispatch);
      return { ...result, metadata: { ...result.metadata, restored: true } };
    });
  }

  private directoryVersion(target: Target, identity: string, nativeVersion: string): string {
    return this.options.recovery.version(this.context(target, 'directory'), Buffer.from(JSON.stringify({ identity, nativeVersion })));
  }

  private async movingSnapshot(input: Target): Promise<MovingSnapshot> {
    const stat = await this.invoke(input.root, { operation: 'stat', path: input.path });
    if (stat.kind === 'file') {
      const snapshot = await this.snapshot(input);
      if (snapshot.identity !== stat.identity) throw denied();
      return { kind: 'file', snapshot, identity: snapshot.identity, version: snapshot.version };
    }
    if (stat.kind !== 'directory' || input.path === '.') throw denied();
    const tree = await this.invoke(input.root, { operation: 'treeStat', path: input.path });
    if (typeof tree.identity !== 'string' || tree.identity !== stat.identity || !IDENTITY.test(tree.identity) ||
        typeof tree.version !== 'string' || !VERSION.test(tree.version)) throw denied();
    return { kind: 'directory', identity: tree.identity, nativeVersion: tree.version,
      version: this.directoryVersion(input, tree.identity, tree.version) };
  }

  private nativePreimage(snapshot: MovingSnapshot) {
    return snapshot.kind === 'directory'
      ? { expectedKind: 'directory' as const, expectedFileIdentity: snapshot.identity, expectedVersion: snapshot.nativeVersion }
      : { expectedKind: 'file' as const, expectedFileIdentity: snapshot.identity, expectedBase64: snapshot.snapshot.bytes.toString('base64') };
  }

  private async authorizeMoving(id: string, input: Target, snapshot: MovingSnapshot, destination?: string, live = true, required = false): Promise<void> {
    if (!required && snapshot.kind === 'file' && !snapshot.snapshot.sensitive) return;
    if (!this.options.consent) throw denied();
    const operation: LocalOwnerOperation = { taskId: id, action: 'destructive', rootId: input.root,
      rootIdentity: this.rootIdentity(input.root), path: input.path, fileIdentity: snapshot.identity,
      targetState: 'EXISTING', preimageDigest: snapshot.version, postimageDigest: null,
      destination: destination ?? null, destinationRootIdentity: destination ? this.rootIdentity(input.root) : null };
    const grant = await this.options.consent.request(operation);
    if (!grant) throw denied();
    if (live) {
      const current = await this.movingSnapshot(input);
      if (current.identity !== snapshot.identity || current.version !== snapshot.version) throw denied();
    }
    if (!this.options.consent.consume(grant.capability, operation)) throw denied();
  }

  async move(input: CopyInput): Promise<MutationResult> {
    shape(input, ['root', 'path', 'destination', 'expectedVersion'], ['requestId']);
    this.target(input);path(input.destination);expected(input.expectedVersion);
    if (input.path === input.destination || input.destination.startsWith(input.path + '/')) throw denied();
    return this.mutate(input, 'move', { operation: 'move', path: input.path, destination: input.destination,
      expectedVersion: input.expectedVersion }, async (id, dispatch) => {
      const snapshot = await this.movingSnapshot(input);
      if (snapshot.version !== input.expectedVersion) throw denied();
      await this.authorizeMoving(id, input, snapshot, input.destination);
      await dispatch({ operation: 'move', path: input.path, destination: input.destination,
        expectedRootIdentity: this.rootIdentity(input.root), ...this.nativePreimage(snapshot) });
      const target = { root: input.root, path: input.destination };
      return { metadata: { moved: true, sourceRemoved: true, version: snapshot.kind === 'file'
        ? this.options.recovery.version(this.context(target), snapshot.snapshot.bytes)
        : this.directoryVersion(target, snapshot.identity, snapshot.nativeVersion) } };
    });
  }

  async trash(input: MutationTarget & { expectedVersion: string }): Promise<MutationResult> {
    shape(input, ['root', 'path', 'expectedVersion'], ['requestId']);
    this.target(input);expected(input.expectedVersion);
    return this.mutate(input, 'trash', { operation: 'trash', path: input.path, expectedVersion: input.expectedVersion }, async (id, dispatch) => {
      const snapshot = await this.movingSnapshot(input);
      if (snapshot.version !== input.expectedVersion) throw denied();
      await this.authorizeMoving(id, input, snapshot, undefined, true, true);
      const vaultId = randomUUID();
      const descriptor = snapshot.kind === 'directory'
        ? { kind: snapshot.kind, identity: snapshot.identity, nativeVersion: snapshot.nativeVersion, vaultId }
        : { kind: snapshot.kind, identity: snapshot.identity, base64: snapshot.snapshot.bytes.toString('base64'), vaultId };
      const recovery = this.options.recovery.capture(this.context(input, 'trash', snapshot.identity), Buffer.from(JSON.stringify(descriptor)));
      this.options.journal.attachRecovery(id, recovery.recoveryId);
      await dispatch({ operation: 'trash', path: input.path, recoveryId: vaultId,
        expectedRootIdentity: this.rootIdentity(input.root), ...this.nativePreimage(snapshot) });
      return { metadata: { moved: true, sourceRemoved: true, ...recovery } };
    });
  }

  async patch(input: PatchInput): Promise<MutationResult> {
    shape(input, ['root', 'path', 'find', 'replacement', 'expectedVersion'], ['requestId']);
    this.target(input);
    expected(input.expectedVersion);
    content(input.find);
    content(input.replacement);
    return this.mutate(input, 'patch', { operation: 'patch', path: input.path,
      expectedVersion: input.expectedVersion, find: input.find, replacement: input.replacement }, async (id, dispatch) => {
      const old = await this.snapshot(input);
      const oldText = old.text ?? '';
      const first = old.text === null ? -1 : oldText.indexOf(input.find);
      const unique = input.find.length > 0 && first >= 0 &&
        oldText.indexOf(input.find, first + 1) < 0;
      const proposed = unique ? Buffer.from(oldText.slice(0, first) + input.replacement +
        oldText.slice(first + input.find.length)) : old.bytes;
      // Approval precedes all sensitive match/version failures. No error carries
      // the find string, replacement, raw content, or match count.
      await this.authorize(id, input, old, proposed);
      if (!unique || old.version !== input.expectedVersion || proposed.length > WRITE_LIMIT) throw denied();
      return this.replace(id, input, old, proposed, 'write', dispatch);
    });
  }

  async mkdir(input: MutationTarget): Promise<MutationResult> {
    shape(input, ['root', 'path'], ['requestId']);
    return this.mutate(input, 'mkdir', { operation: 'mkdir', path: input.path }, async (_id, dispatch) => {
      await dispatch({ operation: 'mkdir', path: input.path,
        expectedRootIdentity: this.rootIdentity(input.root) });
      return { metadata: { created: true } };
    });
  }

  async copy(input: CopyInput): Promise<MutationResult> {
    shape(input, ['root', 'path', 'destination', 'expectedVersion'], ['requestId']);
    this.target(input);
    path(input.destination);
    expected(input.expectedVersion);
    const destination = { root: input.root, path: input.destination,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }) };
    return this.mutate(destination, 'copy', { operation: 'copy', source: input.path,
      destination: input.destination, expectedVersion: input.expectedVersion }, async (id, dispatch) => {
      const source = await this.snapshot(input);
      if (source.version !== input.expectedVersion) throw denied();
      await this.authorize(id, destination, null, source.bytes, { target: input, snapshot: source });
      return this.replace(id, destination, null, source.bytes, 'copy', dispatch);
    });
  }
}
