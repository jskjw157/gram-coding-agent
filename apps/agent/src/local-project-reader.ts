import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync, type BigIntStats,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type {
  LocalProjectEntry, LocalProjectListView, LocalProjectReadView, LocalProjectToolsPort,
} from '@gram/mcp';
import type { SecretRedactor } from '@gram/secrets';

const MAX_FILE_BYTES = 262144;
const MAX_ENTRIES = 120;
const MAX_RESPONSE_CHARS = 32000;
const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|txt|css|scss|less|html|vue|svelte|yaml|yml|svg)$/iu;
const FORBIDDEN_PART = /^(?:\.|node_modules$|dist$|build$|coverage$|vendor$|\.pnpm$|\.next$|\.nuxt$)/iu;
const SENSITIVE_NAME = /(?:secret|credential|private[-_]?key|api[-_]?key|token|password|passwd|id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$|\.key$|\.env|\.npmrc|\.yarnrc)/iu;
const SECRET_CONTENT = /(?:-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:password|private_key|api_key|access_token)\s*[:=]\s*['"][^'"]{8,}['"]|\bAKIA[0-9A-Z]{16}\b|\bgithub_pat_[a-z0-9_]{10,}|\bgh[opusr]_[a-z0-9]{10,}|\bsk-[a-z0-9_-]{10,})/iu;

function hasInvalidControl(value: string, allowWhitespace: boolean): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code === 127 || (code < 32 && (!allowWhitespace || (code !== 9 && code !== 10 && code !== 13)))) {
      return true;
    }
  }
  return false;
}

function rejected(): Error {
  return new Error('Local project read rejected: path, file type or contents are not permitted');
}

function partsOf(path: string, directory: boolean): string[] {
  if (path === '.' && directory) return [];
  if (!path || path.length > 2048 || path.startsWith('/') || path.includes('\\') ||
    path.includes(':') || hasInvalidControl(path, false)) throw rejected();
  const parts = path.split('/');
  if (parts.length > 40 || parts.some(part =>
    !part || part === '.' || part === '..' || part.startsWith('.') ||
    part.endsWith('.') || part.endsWith(' ') || FORBIDDEN_PART.test(part) ||
    SENSITIVE_NAME.test(part))) throw rejected();
  if (!directory && !SOURCE_FILE.test(parts[parts.length - 1] ?? '')) throw rejected();
  return parts;
}

function identity(stat: BigIntStats): string {
  return String(stat.dev) + ':' + String(stat.ino);
}

/**
 * Trusted controller-side one-root-only source viewer. Opens every child relative
 * to a pinned parent descriptor via /proc/self/fd with O_NOFOLLOW. No shell,
 * task lock, task worktree, write, or user-supplied root.
 */
export class ReadOnlyLocalProject implements LocalProjectToolsPort {
  private readonly root: string;
  private readonly rootIdentity: string;
  private readonly redactor: SecretRedactor;

  constructor(options: { root: string; redactor: SecretRedactor }) {
    if (!isAbsolute(options.root)) throw rejected();
    const root = resolve(options.root);
    const stat = lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root) !== root) throw rejected();
    this.root = root;
    this.rootIdentity = identity(stat);
    this.redactor = options.redactor;
  }

  private openPath(parts: readonly string[], directory: boolean): number {
    let fd: number | undefined;
    try {
      const rootStat = lstatSync(this.root, { bigint: true });
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() ||
        identity(rootStat) !== this.rootIdentity || realpathSync(this.root) !== this.root) {
        throw rejected();
      }
      fd = openSync(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (identity(fstatSync(fd, { bigint: true })) !== this.rootIdentity) throw rejected();
      for (let i = 0; i < parts.length; i++) {
        const item = parts[i];
        if (item === undefined) throw rejected();
        const directoryPart = directory || i < parts.length - 1;
        const next = openSync('/proc/self/fd/' + fd + '/' + item,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK |
          (directoryPart ? constants.O_DIRECTORY : 0));
        closeSync(fd);
        fd = next;
      }
      const stat = fstatSync(fd, { bigint: true });
      if (directory ? !stat.isDirectory() : (!stat.isFile() || stat.nlink !== 1n ||
        stat.size > BigInt(MAX_FILE_BYTES))) throw rejected();
      const result = fd;
      fd = undefined;
      return result;
    } catch {
      throw rejected();
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  list(path: string): LocalProjectListView {
    const parts = partsOf(path, true);
    const fd = this.openPath(parts, true);
    try {
      const names = readdirSync('/proc/self/fd/' + fd, { withFileTypes: true });
      const visible: LocalProjectEntry[] = [];
      for (const item of names) {
        try {
          partsOf([...parts, item.name].join('/'), true);
        } catch { continue; }
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory() || (item.isFile() && SOURCE_FILE.test(item.name))) {
          visible.push({ name: item.name, type: item.isDirectory() ? 'directory' : 'file' });
        }
      }
      visible.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      return { path, entries: visible.slice(0, MAX_ENTRIES), truncated: visible.length > MAX_ENTRIES };
    } catch {
      throw rejected();
    } finally {
      closeSync(fd);
    }
  }

  read(path: string, startLine: number, maxLines: number): LocalProjectReadView {
    const parts = partsOf(path, false);
    if (!Number.isSafeInteger(startLine) || startLine < 1 || startLine > 1000000 ||
      !Number.isSafeInteger(maxLines) || maxLines < 1 || maxLines > 200) throw rejected();
    const fd = this.openPath(parts, false);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (before.size > BigInt(MAX_FILE_BYTES)) throw rejected();
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const n = readSync(fd, bytes, length, bytes.length - length, length);
        if (n === 0) break;
        length += n;
      }
      const after = fstatSync(fd, { bigint: true });
      if (length > MAX_FILE_BYTES || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        before.ino !== after.ino || before.dev !== after.dev ||
        before.nlink !== after.nlink) throw rejected();
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      if (hasInvalidControl(content, true) ||
        SECRET_CONTENT.test(content) || this.redactor.redact(content) !== content) throw rejected();
      const lines = content.split(/\r?\n/u);
      if (lines.at(-1) === '') lines.pop();
      const selection = lines.slice(startLine - 1, startLine - 1 + maxLines);
      const selected = selection.join('\n');
      if (selected.length > MAX_RESPONSE_CHARS) throw rejected();
      return {
        path,
        startLine,
        endLine: startLine + selection.length - 1,
        totalLines: lines.length,
        content: selected,
        truncated: startLine - 1 + selection.length < lines.length,
      };
    } catch {
      throw rejected();
    } finally {
      closeSync(fd);
    }
  }
}
