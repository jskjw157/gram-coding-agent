import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { SecretRedactor } from '@gram/secrets';
import { MultiRootLocalFs } from './local-fs.js';

const created: string[] = [];
function fixture({ readOnly = false, stateInsideRoot = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gram-mcp-owner-fs-'));
  created.push(root);
  const stateDirectory = stateInsideRoot
    ? join(root, '.gram-agent-private')
    : mkdtempSync(join(tmpdir(), 'gram-mcp-state-'));
  if (!stateInsideRoot) created.push(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true });
  const secretDirectory = join(stateDirectory, 'secrets');
  mkdirSync(secretDirectory);
  const fs = new MultiRootLocalFs({
    roots: { 'windows-c': { path: root, label: 'C drive', writable: !readOnly } },
    stateDirectory, secretDirectory, redactor: new SecretRedactor(['gram-controller-private-secret']),
  });
  return { fs, root, stateDirectory, secretDirectory };
}
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('multi-root local file operations', () => {
  it('enumerates permitted roots, hidden files, file stats and masked config content', () => {
    const { fs, root } = fixture();
    writeFileSync(join(root, '.env'), 'APP_TOKEN=super-private-test-value\nSAFE=enabled\n');
    writeFileSync(join(root, 'README.md'), 'First\nSecond\nThird\n');
    expect(fs.roots()).toEqual([{ id: 'windows-c', label: 'C drive', writable: true, kind: 'wsl-directory' }]);
    const list = fs.list({ root: 'windows-c', path: '.', offset: 0, limit: 100 });
    expect(list.entries.map(x => x.name)).toEqual(['.env', 'README.md']);
    expect(fs.stat({ root: 'windows-c', path: 'README.md' })).toMatchObject({
      kind: 'file', sha256: hash('First\nSecond\nThird\n'),
    });
    expect(fs.read({ root: 'windows-c', path: 'README.md', startLine: 2, maxLines: 1 }))
      .toMatchObject({ content: 'Second', totalLines: 3, masked: false });
    const env = fs.read({ root: 'windows-c', path: '.env', startLine: 1, maxLines: 5 });
    expect(env.masked).toBe(true);
    expect(env.content).toContain('APP_TOKEN=***REDACTED***');
    expect(env.content).toContain('SAFE=enabled');
    expect(env.content).not.toContain('super-private-test-value');
  });

  it('creates, patches and replaces with SHA-based optimistic concurrency and a private backup', () => {
    const { fs, root, stateDirectory } = fixture();
    fs.mkdir({ root: 'windows-c', path: 'src' });
    expect(statSync(join(root, 'src')).isDirectory()).toBe(true);
    const createdResult = fs.write({
      root: 'windows-c', path: 'src/index.ts', expectedSha256: null, content: 'export const n = 1;\n',
    });
    expect(createdResult.sha256).toBe(hash('export const n = 1;\n'));
    expect(() => fs.write({
      root: 'windows-c', path: 'src/index.ts', expectedSha256: null, content: 'overwrite',
    })).toThrow(/denied/u);
    expect(() => fs.patch({
      root: 'windows-c', path: 'src/index.ts', expectedSha256: '0'.repeat(64),
      find: 'n = 1', replacement: 'n = 2',
    })).toThrow(/denied/u);
    const modified = fs.patch({
      root: 'windows-c', path: 'src/index.ts', expectedSha256: createdResult.sha256,
      find: 'n = 1', replacement: 'n = 2',
    });
    expect(modified.sha256).toBe(hash('export const n = 2;\n'));
    expect(modified.backup?.originalSha256).toBe(createdResult.sha256);
    expect(readFileSync(join(root, 'src/index.ts'), 'utf8')).toBe('export const n = 2;\n');
    expect(readFileSync(join(stateDirectory, 'local-file-recovery', modified.backup?.backupId ?? ''), 'utf8'))
      .toBe('export const n = 1;\n');
    expect(() => fs.patch({
      root: 'windows-c', path: 'src/index.ts', expectedSha256: modified.sha256,
      find: 'never existed', replacement: 'new',
    })).toThrow(/denied/u);
  });

  it('copies, renames, searches and recoverably trashes files', () => {
    const { fs, root } = fixture();
    mkdirSync(join(root, 'source'));
    writeFileSync(join(root, 'source', 'data.json'), '{ "message": "hello safe world" }\n');
    const id = fs.stat({ root: 'windows-c', path: 'source/data.json' }).sha256;
    expect(id).toBe(hash('{ "message": "hello safe world" }\n'));
    fs.copy({
      root: 'windows-c', path: 'source/data.json', destination: 'data-copy.json', expectedSha256: id ?? '',
    });
    expect(existsSync(join(root, 'data-copy.json'))).toBe(true);
    fs.move({
      root: 'windows-c', path: 'data-copy.json', destination: 'source/moved.json',
      expectedSha256: id ?? '',
    });
    expect(existsSync(join(root, 'data-copy.json'))).toBe(false);
    const search = fs.search({
      root: 'windows-c', path: 'source', term: 'hello', maxResults: 10, maxDepth: 3,
    });
    expect(search.results.map(x => x.path).sort()).toEqual(['source/data.json', 'source/moved.json']);
    const trashed = fs.trash({
      root: 'windows-c', path: 'source/moved.json', expectedSha256: id ?? '',
    });
    expect(existsSync(join(root, 'source/moved.json'))).toBe(false);
    expect(existsSync(join(root, trashed.recoveryPath))).toBe(true);
    expect(readFileSync(join(root, trashed.recoveryPath), 'utf8')).toContain('hello safe world');
  });

  it('rejects path traversal, symlink exits, protected Agent state and hardlink writes', () => {
    const { fs, root } = fixture({ stateInsideRoot: true });
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'main.ts'), 'export const ok = true;\n');
    writeFileSync(join(root, '.gram-agent-private', 'credentials.json'), '{"secret":"hidden"}');
    const id = hash('export const ok = true;\n');
    for (const path of ['../outside', '/etc/passwd', 'C:\\Users\\x', 'src\\main.ts',
      'src/../.gram-agent-private/credentials.json', '.gram-agent-private/credentials.json']) {
      expect(() => fs.read({ root: 'windows-c', path, startLine: 1, maxLines: 20 }), path)
        .toThrow(/denied/u);
    }
    symlinkSync(join(root, '.gram-agent-private'), join(root, 'link'));
    expect(() => fs.list({ root: 'windows-c', path: 'link', offset: 0, limit: 5 })).toThrow(/denied/u);
    linkSync(join(root, 'src', 'main.ts'), join(root, 'hardlink.ts'));
    expect(() => fs.write({
      root: 'windows-c', path: 'src/main.ts', expectedSha256: id, content: 'replacement',
    })).toThrow(/denied/u);
    expect(readFileSync(join(root, 'src/main.ts'), 'utf8')).toContain('true');
  });

  it('refuses writes in read-only roots and rejects invalid root configuration', () => {
    const { fs } = fixture({ readOnly: true });
    expect(() => fs.mkdir({ root: 'windows-c', path: 'new' })).toThrow(/denied/u);
    expect(() => fs.read({ root: 'other-drive', path: '.env', startLine: 1, maxLines: 20 }))
      .toThrow(/denied/u);
    expect(() => MultiRootLocalFs.fromConfig('{bad JSON', {
      stateDirectory: '/tmp/state', secretDirectory: '/tmp/secret', redactor: new SecretRedactor(),
    })).toThrow(/denied/u);
  });
});
