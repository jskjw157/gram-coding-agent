import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync,
  lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync,
  renameSync, unlinkSync, writeFileSync, writeSync, type BigIntStats,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { LocalFsToolsPort } from '@gram/mcp';
import type { SecretRedactor } from '@gram/secrets';

const READ_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 32000;
const FIND_LIMIT = 500;
const NAME_LIMIT = 2048;
type Root = { id: string; label: string; path: string; writable: boolean; fingerprint: string };
type ConfigEntry = { path: string; writable: boolean; label?: string };
type Inputs = {
  list: Parameters<LocalFsToolsPort['list']>[0];
  stat: Parameters<LocalFsToolsPort['stat']>[0];
  read: Parameters<LocalFsToolsPort['read']>[0];
  search: Parameters<LocalFsToolsPort['search']>[0];
  write: Parameters<LocalFsToolsPort['write']>[0];
  patch: Parameters<LocalFsToolsPort['patch']>[0];
  mkdir: Parameters<LocalFsToolsPort['mkdir']>[0];
  move: Parameters<LocalFsToolsPort['move']>[0];
  copy: Parameters<LocalFsToolsPort['copy']>[0];
  trash: Parameters<LocalFsToolsPort['trash']>[0];
};

function denied(): Error {
  return new Error('Local filesystem operation denied: invalid path, permission, version or unsupported entry');
}
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel));
}
function fingerprint(st: BigIntStats): string {
  return String(st.dev) + ':' + String(st.ino);
}
function parts(path: string, allowRoot = false): string[] {
  if (path === '.' && allowRoot) return [];
  if (!path || path.length > NAME_LIMIT || path.startsWith('/') || path.includes('\\') ||
      path.includes(':')) throw denied();
  for (const char of path) {
    const ch = char.charCodeAt(0);
    if (ch < 32 || ch === 127) throw denied();
  }
  const items = path.split('/');
  if (items.length > 60 || items.some(p => !p || p === '.' || p === '..' || p.endsWith(' ') ||
      p.endsWith('.') || p.includes('\0'))) throw denied();
  return items;
}
function hash(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function isProtected(path: string, protectedRoots: readonly string[]): boolean {
  return protectedRoots.some(p => within(p, path));
}
function readFd(fd: number): Buffer {
  const before = fstatSync(fd, { bigint: true });
  if (!before.isFile() || before.size > BigInt(READ_LIMIT)) throw denied();
  const bytes = Buffer.alloc(READ_LIMIT + 1);
  let size = 0;
  while (size < bytes.length) {
    const count = readSync(fd, bytes, size, bytes.length - size, size);
    if (count === 0) break;
    size += count;
  }
  const after = fstatSync(fd, { bigint: true });
  if (size > READ_LIMIT || before.ino !== after.ino || before.dev !== after.dev ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs) throw denied();
  return bytes.subarray(0, size);
}
function asText(bytes: Buffer): string {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw denied();
  return text;
}
function secretSafe(text: string, redactor: SecretRedactor): { content: string; masked: boolean } {
  let value = redactor.redact(text);
  value = value.replace(
    /(^[ \t]*[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*[ \t]*=[ \t]*)[^\r\n]+/gimu,
    '$1***REDACTED***',
  );
  value = value.replace(
    /("[^"]*(?:token|key|secret|password|credential)[^"]*"[ \t]*:[ \t]*")[^"]*(")/giu,
    '$1***REDACTED***$2',
  );
  return { content: value, masked: value !== text };
}
function writeComplete(fd: number, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count <= 0) throw denied();
    offset += count;
  }
  fsyncSync(fd);
}

export class MultiRootLocalFs implements LocalFsToolsPort {
  private readonly registered: Map<string, Root>;
  private readonly protectedRoots: string[];
  private readonly backups: string;
  private readonly redactor: SecretRedactor;

  constructor(options: {
    roots: Record<string, ConfigEntry>;
    stateDirectory: string;
    secretDirectory: string;
    redactor: SecretRedactor;
  }) {
    this.registered = new Map();
    this.protectedRoots = [resolve(options.stateDirectory), resolve(options.secretDirectory)];
    this.backups = resolve(options.stateDirectory, 'local-file-recovery');
    this.redactor = options.redactor;
    for (const [id, spec] of Object.entries(options.roots)) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(id) || !spec || typeof spec.path !== 'string' ||
          typeof spec.writable !== 'boolean' || !isAbsolute(spec.path)) throw denied();
      const root = resolve(spec.path);
      const st = lstatSync(root, { bigint: true });
      if (!st.isDirectory() || st.isSymbolicLink() || realpathSync(root) !== root ||
          isProtected(root, this.protectedRoots)) throw denied();
      this.registered.set(id, {
        id, label: spec.label ?? id, path: root, writable: spec.writable, fingerprint: fingerprint(st),
      });
    }
    if (this.registered.size === 0 || this.registered.size > 12) throw denied();
  }

  static fromConfig(json: string, options: {
    stateDirectory: string;
    secretDirectory: string;
    redactor: SecretRedactor;
  }): MultiRootLocalFs {
    let data: unknown;
    try { data = JSON.parse(json) as unknown; } catch { throw denied(); }
    if (!data || Array.isArray(data) || typeof data !== 'object') throw denied();
    return new MultiRootLocalFs({
      ...options,
      roots: data as Record<string, ConfigEntry>,
    });
  }

  roots() {
    return [...this.registered.values()].map(r => ({
      id: r.id, label: r.label, writable: r.writable,
      kind: r.path.startsWith('/mnt/') ? 'windows-drive' : 'wsl-directory',
    }));
  }

  private findRoot(id: string, write = false): Root {
    const root = this.registered.get(id);
    if (!root || (write && !root.writable)) throw denied();
    const st = lstatSync(root.path, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink() || fingerprint(st) !== root.fingerprint ||
        realpathSync(root.path) !== root.path) throw denied();
    return root;
  }

  // No symlink-following during traversal, including hidden directories and
  // ancestor components. Each open is relative to a kernel-held directory FD.
  private open(root: Root, segments: readonly string[], directory: boolean): number {
    let fd: number | undefined;
    try {
      fd = openSync(root.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (fingerprint(fstatSync(fd, { bigint: true })) !== root.fingerprint) throw denied();
      const fullRoot = realpathSync('/proc/self/fd/' + fd);
      if (fullRoot !== root.path) throw denied();
      for (let i = 0; i < segments.length; i++) {
        const name = segments[i];
        if (name === undefined) throw denied();
        const expectDir = directory || i < segments.length - 1;
        const next = openSync('/proc/self/fd/' + fd + '/' + name,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
          (expectDir ? constants.O_DIRECTORY : 0));
        closeSync(fd);
        fd = next;
        const actual = realpathSync('/proc/self/fd/' + fd);
        if (!within(root.path, actual) || isProtected(actual, this.protectedRoots)) throw denied();
      }
      const st = fstatSync(fd, { bigint: true });
      if (directory ? !st.isDirectory() : (!st.isFile() || st.size > BigInt(READ_LIMIT))) throw denied();
      const result = fd;
      fd = undefined;
      return result;
    } catch {
      throw denied();
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  private parent(root: Root, relativePath: string, write: boolean) {
    if (write && !root.writable) throw denied();
    const segments = parts(relativePath);
    const filename = segments.at(-1);
    if (filename === undefined) throw denied();
    const parents = segments.slice(0, -1);
    const canonical = resolve(root.path, ...segments);
    if (!within(root.path, canonical) || isProtected(canonical, this.protectedRoots)) throw denied();
    const fd = this.open(root, parents, true);
    return { fd, filename, path: '/proc/self/fd/' + fd + '/' + filename };
  }

  private existing(root: Root, path: string) {
    const fd = this.open(root, parts(path), false);
    try {
      return { buffer: readFd(fd), mode: fstatSync(fd, { bigint: true }).mode & 0o777n };
    } finally { closeSync(fd); }
  }

  stat(input: Inputs['stat']) {
    const root = this.findRoot(input.root);
    if (input.path === '.') {
      const fd = this.open(root, [], true);
      try {
        return { root: root.id, path: '.', kind: 'directory', bytes: Number(fstatSync(fd, { bigint: true }).size) };
      } finally { closeSync(fd); }
    }
    const ref = this.parent(root, input.path, false);
    try {
      const st = lstatSync(ref.path, { bigint: true });
      const kind = st.isDirectory() ? 'directory' :
        st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : 'other';
      let sha256: string | null = null;
      if (kind === 'file' && st.size <= BigInt(READ_LIMIT)) {
        sha256 = hash(this.existing(root, input.path).buffer);
      }
      return { root: root.id, path: input.path, kind, bytes: Number(st.size), sha256 };
    } catch { throw denied(); } finally { closeSync(ref.fd); }
  }

  list(input: Inputs['list']) {
    const root = this.findRoot(input.root);
    const fd = this.open(root, parts(input.path, true), true);
    try {
      const items = readdirSync('/proc/self/fd/' + fd, { withFileTypes: true })
        .map(item => ({
          name: item.name,
          type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' :
            item.isSymbolicLink() ? 'symlink' : 'other',
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'en'));
      const filtered = items.filter(item => {
        const target = resolve(root.path, input.path === '.' ? '' : input.path, item.name);
        return !isProtected(target, this.protectedRoots);
      });
      return {
        root: root.id, path: input.path, total: filtered.length,
        entries: filtered.slice(input.offset, input.offset + input.limit),
        nextOffset: input.offset + input.limit < filtered.length ? input.offset + input.limit : null,
      };
    } catch { throw denied(); } finally { closeSync(fd); }
  }

  read(input: Inputs['read']) {
    const root = this.findRoot(input.root);
    const { buffer } = this.existing(root, input.path);
    const original = asText(buffer);
    const screened = secretSafe(original, this.redactor);
    const lines = screened.content.split(/\r?\n/u);
    if (lines.at(-1) === '') lines.pop();
    const content = lines.slice(input.startLine - 1, input.startLine - 1 + input.maxLines).join('\n');
    if (content.length > TEXT_LIMIT) throw denied();
    return {
      root: root.id, path: input.path, startLine: input.startLine,
      endLine: Math.min(lines.length, input.startLine + input.maxLines - 1),
      totalLines: lines.length, content, masked: screened.masked,
      sha256: hash(buffer),
    };
  }

  search(input: Inputs['search']) {
    const root = this.findRoot(input.root);
    const term = input.term.toLocaleLowerCase('en');
    const results: Array<{ path: string; line: number; text: string }> = [];
    let visited = 0;
    const deadline = Date.now() + 2500;
    const walk = (dir: string, depth: number) => {
      if (results.length >= input.maxResults || visited >= FIND_LIMIT || Date.now() > deadline) return;
      const listing = this.list({ root: root.id, path: dir, offset: 0, limit: 100 });
      for (const entry of listing.entries) {
        if (results.length >= input.maxResults || visited >= FIND_LIMIT || Date.now() > deadline) return;
        visited++;
        const path = dir === '.' ? entry.name : dir + '/' + entry.name;
        if (entry.type === 'directory' && depth < input.maxDepth) { walk(path, depth + 1); continue; }
        if (entry.type !== 'file') continue;
        try {
          const screen = secretSafe(asText(this.existing(root, path).buffer), this.redactor);
          const lines = screen.content.split(/\r?\n/u);
          for (let i = 0; i < lines.length; i++) {
            const text = lines[i] ?? '';
            if (text.toLocaleLowerCase('en').includes(term)) {
              results.push({ path, line: i + 1, text: text.slice(0, 350) });
              if (results.length >= input.maxResults) break;
            }
          }
        } catch { /* Binary, protected or unreadable content is skipped. */ }
      }
    };
    const start = parts(input.path, true);
    const dirFd = this.open(root, start, true);
    closeSync(dirFd);
    walk(input.path, 0);
    return { root: root.id, path: input.path, results, examinedEntries: visited,
      truncated: visited >= FIND_LIMIT || results.length >= input.maxResults || Date.now() > deadline };
  }

  // Store the exact old file in controller-private 0700 recovery storage before
  // mutation; never persist content or credentials in MCP results/audit logs.
  private backup(root: Root, path: string, bytes: Buffer) {
    mkdirSync(this.backups, { recursive: true, mode: 0o700 });
    const name = randomUUID() + '.backup';
    const file = join(this.backups, name);
    writeFileSync(file, bytes, { flag: 'wx', mode: 0o600, flush: true });
    return { backupId: name, originalSha256: hash(bytes), root: root.id, path };
  }

  private put(root: Root, path: string, expectedSha256: string | null, bytes: Buffer) {
    if (!root.writable || bytes.length > READ_LIMIT) throw denied();
    const ref = this.parent(root, path, true);
    try {
      const existingPath = ref.path;
      let original: Buffer | undefined;
      let mode = 0o600;
      if (expectedSha256 !== null) {
        original = this.existing(root, path).buffer;
        if (hash(original) !== expectedSha256) throw denied();
        const st = lstatSync(existingPath, { bigint: true });
        if (!st.isFile() || st.nlink !== 1n) throw denied();
        mode = Number(st.mode & 0o777n);
      } else if (existsSync(existingPath)) throw denied();
      const backup = original === undefined ? null : this.backup(root, path, original);
      if (expectedSha256 === null) {
        const fd = openSync(existingPath, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeComplete(fd, bytes); }
        catch (error) { try { unlinkSync(existingPath); } catch { /* Preserve failure. */ } throw error; }
        finally { closeSync(fd); }
      } else {
        const tempName = '.gram-tmp-' + randomUUID();
        const tempPath = '/proc/self/fd/' + ref.fd + '/' + tempName;
        const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT |
          constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          writeComplete(fd, bytes);
          fchmodSync(fd, mode);
          if (hash(this.existing(root, path).buffer) !== expectedSha256) throw denied();
          renameSync(tempPath, existingPath);
        } finally {
          closeSync(fd);
          try { unlinkSync(tempPath); } catch { /* Renamed or inaccessible. */ }
        }
      }
      return { root: root.id, path, sha256: hash(bytes), previousSha256: expectedSha256, backup };
    } finally { closeSync(ref.fd); }
  }

  write(input: Inputs['write']) {
    return this.put(this.findRoot(input.root, true), input.path, input.expectedSha256,
      Buffer.from(input.content, 'utf8'));
  }

  patch(input: Inputs['patch']) {
    const root = this.findRoot(input.root, true);
    const original = this.existing(root, input.path).buffer;
    if (hash(original) !== input.expectedSha256) throw denied();
    const content = asText(original);
    const position = content.indexOf(input.find);
    if (position < 0 || content.indexOf(input.find, position + input.find.length) !== -1) throw denied();
    const changed = content.slice(0, position) + input.replacement + content.slice(position + input.find.length);
    return this.put(root, input.path, input.expectedSha256, Buffer.from(changed, 'utf8'));
  }

  mkdir(input: Inputs['mkdir']) {
    const root = this.findRoot(input.root, true);
    const ref = this.parent(root, input.path, true);
    try {
      mkdirSync(ref.path, { mode: 0o700 });
      return { root: root.id, path: input.path, created: true };
    } finally { closeSync(ref.fd); }
  }

  move(input: Inputs['move']) {
    const root = this.findRoot(input.root, true);
    const source = this.parent(root, input.path, true);
    const dest = this.parent(root, input.destination, true);
    try {
      const data = this.existing(root, input.path).buffer;
      if (hash(data) !== input.expectedSha256 || existsSync(dest.path)) throw denied();
      renameSync(source.path, dest.path);
      return { root: root.id, source: input.path, destination: input.destination,
        sha256: input.expectedSha256, moved: true };
    } finally { closeSync(source.fd); closeSync(dest.fd); }
  }

  copy(input: Inputs['copy']) {
    const root = this.findRoot(input.root, true);
    const bytes = this.existing(root, input.path).buffer;
    if (hash(bytes) !== input.expectedSha256) throw denied();
    const result = this.put(root, input.destination, null, bytes);
    return { ...result, copiedFrom: input.path };
  }

  trash(input: Inputs['trash']) {
    const root = this.findRoot(input.root, true);
    const source = this.parent(root, input.path, true);
    let trashFd: number | undefined;
    try {
      const bytes = this.existing(root, input.path).buffer;
      if (hash(bytes) !== input.expectedSha256) throw denied();
      const folder = '/proc/self/fd/' + source.fd + '/.gram-local-trash';
      try { mkdirSync(folder, { mode: 0o700 }); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw denied();
      }
      trashFd = openSync(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const parentCanonical = realpathSync('/proc/self/fd/' + source.fd);
      const trashCanonical = realpathSync('/proc/self/fd/' + trashFd);
      const st = fstatSync(trashFd, { bigint: true });
      if (trashCanonical !== parentCanonical + '/.gram-local-trash' ||
          !within(root.path, trashCanonical) || (st.mode & 0o022n) !== 0n) throw denied();
      if (hash(this.existing(root, input.path).buffer) !== input.expectedSha256) throw denied();
      const dstName = randomUUID() + '-' + basename(input.path);
      renameSync(source.path, '/proc/self/fd/' + trashFd + '/' + dstName);
      return { root: root.id, source: input.path,
        recoveryPath: (dirname(input.path) === '.' ? '' : dirname(input.path) + '/') +
          '.gram-local-trash/' + dstName, originalSha256: input.expectedSha256 };
    } catch {
      // Native errors may include absolute controller paths; return a generic denial.
      throw denied();
    } finally {
      if (trashFd !== undefined) closeSync(trashFd);
      closeSync(source.fd);
    }
  }
}
