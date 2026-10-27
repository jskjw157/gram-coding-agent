import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { NativeWorkspaceDeniedError, NativeWorkspaceUnresolvedError } from './windows-workspace-client.js';
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();return { ...fs, open: vi.fn(fs.open) };
});
import { open } from 'node:fs/promises';
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


// Unit IPC receipts: no native executable runs here. Native security/effect
// evidence lives in windows-workspace-native.test.py.
describe('recovery transport outcome receipts', () => {
  function transport() {
    const dir = mkdtempSync(join(tmpdir(), 'gram-native-receipt-'));fixtures.push(dir);
    const path = join(dir, 'helper.exe');writeFileSync(path, 'fixed-fixture');
    return new FixedWindowsWorkspaceTransport({ helperPath: path,
      expectedSha256: createHash('sha256').update('fixed-fixture').digest('hex') });
  }
  function receipt(body: string, code: number, diagnostic = false) {
    const child = Object.assign(new EventEmitter(), { pid: 123, stdin: new PassThrough(),
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from(body));
        if (diagnostic) child.stderr.emit('data', Buffer.from('discarded'));
        child.emit('close', code);
      });
      return child as never;
    });
    return child;
  }
  it('yields helper integrity I/O and never spawns before its asynchronous digest verification finishes', async () => {
    const native = transport();const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    let release = () => {};const gate = new Promise<void>(resolve => {release = resolve;});
    vi.mocked(open).mockImplementationOnce(async (...args) => {await gate;return fs.open(...args);});
    receipt('{"ok":true,"rootIdentity":"1:1"}', 0);
    const before = vi.mocked(spawn).mock.calls.length;const result = native.run(request);
    try {expect(open).toHaveBeenCalled();expect(vi.mocked(spawn).mock.calls.length).toBe(before);}
    finally {release();await result;}
  });
  for (const operation of ['trash', 'restore'] as const) {
    it(`preserves unknown ${operation} outcomes and trusts only an exact rollback receipt`, async () => {
      const native = transport();
      const mutation = { ...request, operation, expectedKind: 'file' as const, expectedRootIdentity: '1:1',
        expectedFileIdentity: '1:2', expectedBase64: '', recoveryRoot: 'C:\\private', recoveryId: 'record', expectedRecoveryRootIdentity: '1:9' };
      for (const [body, code, diagnostic] of [
        ['{"ok":false,"code":"OUTCOME_UNKNOWN"}', 1, false], ['invalid', 0, false],
        ['{"ok":false,"code":"DENIED_NO_CHANGE","unexpected":true}', 1, false],
        ['{"ok":false,"code":"DENIED_NO_CHANGE"}', 1, true],
      ] as const) {
        const child = receipt(body, code, diagnostic);
        await expect(native.run(mutation)).rejects.toBeInstanceOf(NativeWorkspaceUnresolvedError);
        if (diagnostic) expect(child.kill).toHaveBeenCalled();
      }
      receipt('{"ok":false,"code":"DENIED_NO_CHANGE"}', 1);
      await expect(native.run(mutation)).rejects.toBeInstanceOf(NativeWorkspaceDeniedError);
      receipt('{"ok":true,"rootIdentity":"1:1"}', 0);
      await expect(native.run(mutation)).resolves.toEqual({ ok: true, rootIdentity: '1:1' });
    });
  }
});
