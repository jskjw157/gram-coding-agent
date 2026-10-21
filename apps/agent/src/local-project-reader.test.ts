import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretRedactor } from '@gram/secrets';
import { ReadOnlyLocalProject } from './local-project-reader.js';

const created: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gram-local-read-'));
  created.push(root);
  return { root, reader: new ReadOnlyLocalProject({ root, redactor: new SecretRedactor(['known-private-test-secret']) }) };
}
afterEach(() => { for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('one-root read-only local project viewer', () => {
  it('lists bounded visible source entries and reads exact lines', () => {
    const { root, reader } = fixture();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'src', 'index.ts'), 'first\nsecond\nthird\n');
    writeFileSync(join(root, '.env'), 'TOKEN=hidden');
    writeFileSync(join(root, 'node_modules', 'dependency.js'), 'no');
    expect(reader.list('.').entries).toEqual([{ name: 'src', type: 'directory' }]);
    expect(reader.list('src').entries).toEqual([{ name: 'index.ts', type: 'file' }]);
    expect(reader.read('src/index.ts', 2, 1)).toEqual({
      path: 'src/index.ts', startLine: 2, endLine: 2, totalLines: 3,
      content: 'second', truncated: true,
    });
  });

  it('rejects traversal, Windows paths, hidden paths, forbidden types and aliases', () => {
    const { root, reader } = fixture();
    writeFileSync(join(root, 'main.ts'), 'ok');
    writeFileSync(join(root, 'secret-token.ts'), 'hidden');
    for (const path of ['../main.ts', '/etc/passwd', 'C:\\Users\\secret.txt', 'src\\foo.ts',
      'a//b.ts', 'a/./b.ts', 'a/../b.ts', '.env', 'secret-token.ts',
      'main.ts:ads', 'main.ts.', 'main.ts ', 'main.pdf', 'node_modules/a.ts']) {
      expect(() => reader.read(path, 1, 10), path).toThrow(/rejected/u);
    }
    expect(() => reader.list('..')).toThrow(/rejected/u);
  });

  it('rejects intermediate and leaf symlinks, and multi-linked files', () => {
    const { root, reader } = fixture();
    mkdirSync(join(root, 'real'));
    writeFileSync(join(root, 'real', 'ok.ts'), 'ok\n');
    symlinkSync('real', join(root, 'linked'));
    symlinkSync('real/ok.ts', join(root, 'linked.ts'));
    expect(() => reader.list('linked')).toThrow(/rejected/u);
    expect(() => reader.read('linked.ts', 1, 5)).toThrow(/rejected/u);
    linkSync(join(root, 'real', 'ok.ts'), join(root, 'also.ts'));
    expect(() => reader.read('real/ok.ts', 1, 5)).toThrow(/rejected/u);
  });

  it('rejects sensitive contents, binary and oversized files', () => {
    const { root, reader } = fixture();
    writeFileSync(join(root, 'secret.ts'), 'known-private-test-secret');
    writeFileSync(join(root, 'x.ts'), 'known-private-test-secret');
    writeFileSync(join(root, 'binary.ts'), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, 'large.ts'), 'x'.repeat(262145));
    writeFileSync(join(root, 'key.ts'), 'const password = "ultra-sensitive-value";\n');
    for (const path of ['secret.ts', 'x.ts', 'binary.ts', 'large.ts', 'key.ts']) {
      expect(() => reader.read(path, 1, 20), path).toThrow(/rejected/u);
    }
  });

  it('rejects symlink roots', () => {
    const { root } = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'gram-local-root-'));
    created.push(outside);
    symlinkSync(root, join(outside, 'link'));
    expect(() => new ReadOnlyLocalProject({
      root: join(outside, 'link'), redactor: new SecretRedactor(),
    })).toThrow(/rejected/u);
  });

  it('caps listing and pagination', () => {
    const { root, reader } = fixture();
    for (let i = 0; i < 130; i++) {
      writeFileSync(join(root, 'item-' + String(i).padStart(3, '0') + '.ts'), 'ok\n');
    }
    const list = reader.list('.');
    expect(list.entries).toHaveLength(120);
    expect(list.truncated).toBe(true);
    expect(() => reader.read('item-000.ts', 0, 1)).toThrow(/rejected/u);
    expect(() => reader.read('item-000.ts', 1, 201)).toThrow(/rejected/u);
  });
});
