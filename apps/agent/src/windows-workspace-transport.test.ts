import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FixedWindowsWorkspaceTransport } from './windows-workspace-transport.js';

const fixtures: string[] = [];
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
const request = { operation: 'read' as const, root: 'C:\\', path: 'fixture', protectedPaths: ['C:\\private'] };
describe('fixed Windows helper integrity', () => {
  it('denies a changed pinned executable before any process can run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gram-native-pin-'));fixtures.push(dir);
    const path = join(dir, 'helper.exe');writeFileSync(path, 'changed');
    const transport = new FixedWindowsWorkspaceTransport({ helperPath: path, expectedSha256: createHash('sha256').update('original').digest('hex') });
    await expect(transport.run(request)).rejects.toThrow('Native workspace transport denied or failed');
  });
  it('rejects hardlinked executables and invalid executable configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gram-native-pin-'));fixtures.push(dir);
    const path = join(dir, 'helper.exe');writeFileSync(path, 'fixture');linkSync(path, join(dir, 'alias.exe'));
    const transport = new FixedWindowsWorkspaceTransport({ helperPath: path, expectedSha256: createHash('sha256').update('fixture').digest('hex') });
    await expect(transport.run(request)).rejects.toThrow();
    expect(() => new FixedWindowsWorkspaceTransport({ helperPath: 'cmd.exe', expectedSha256: '0'.repeat(64) })).toThrow();
  });
});
