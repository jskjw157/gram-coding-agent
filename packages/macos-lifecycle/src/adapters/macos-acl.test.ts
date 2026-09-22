import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkMacAcl } from './macos-acl.js';
import { createTrustedFiles } from './trusted-files.js';
const exec = promisify(execFile);

describe.skipIf(process.platform !== 'darwin')('native Apple descriptor ACL (never installed)', () => {
  let dir: string; let helper: string; let file: string;
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'gram acl ')));
    helper = join(dir, 'file-acl'); file = join(dir, 'sample');
    await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      fileURLToPath(new URL('../../../../platform/macos/native/file-acl.c', import.meta.url)), '-o', helper]);
    await writeFile(file, 'synthetic-file-not-a-secret', { mode: 0o600 });
  }, 30000);
  afterAll(async () => {
    if (file) await exec('/bin/chmod', ['-N', file]).catch(() => undefined);
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('proves absence of ACL writes on an actual opened file', async () => {
    const handle = await open(file, 'r');
    try { expect(await checkMacAcl(handle, helper)).toBe(true); }
    finally { await handle.close(); }
  });
  it('checks actual directory ACLs and composes with descriptor reads', async () => {
    const files = createTrustedFiles(dir, process.getuid!(), fd => checkMacAcl(fd, helper));
    expect((await files.read('sample', 64)).toString()).toBe('synthetic-file-not-a-secret');
  });
  it('does not read data or advance the inherited descriptor offset', async () => {
    const handle = await open(file, 'r'); const byte = Buffer.alloc(1);
    try {
      await handle.read(byte, 0, 1, null); expect(byte.toString()).toBe('s');
      expect(await checkMacAcl(handle, helper)).toBe(true);
      await handle.read(byte, 0, 1, null); expect(byte.toString()).toBe('y');
    } finally { await handle.close(); }
  });
  it('refuses an actual ACL allow-write grant even when POSIX mode is 0600', async () => {
    await exec('/bin/chmod', ['+a', 'everyone allow write', file]);
    const handle = await open(file, 'r');
    try { expect(await checkMacAcl(handle, helper)).toBe(false); }
    finally { await handle.close(); await exec('/bin/chmod', ['-N', file]); }
  });
  it('permits a restrictive deny-delete ACL without weakening it', async () => {
    await exec('/bin/chmod', ['+a', 'everyone deny delete', file]);
    const handle = await open(file, 'r');
    try { expect(await checkMacAcl(handle, helper)).toBe(true); }
    finally { await handle.close(); await exec('/bin/chmod', ['-N', file]); }
    expect(await readFile(file, 'utf8')).toBe('synthetic-file-not-a-secret');
  });
  it('fails closed when the helper is missing or the descriptor is closed', async () => {
    const handle = await open(file, 'r');
    expect(await checkMacAcl(handle, join(dir, 'missing'))).toBe(false);
    await handle.close(); expect(await checkMacAcl(handle, helper)).toBe(false);
  });
});
