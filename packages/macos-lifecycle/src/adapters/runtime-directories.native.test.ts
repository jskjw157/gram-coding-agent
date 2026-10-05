import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkMacAcl } from './macos-acl.js';
import { inspectRuntimeDirectories } from './runtime-directories.js';
import { bindReviewedCoreRuntimeAt } from './runtime-authority.js';
import { fixture, snapshot } from '../test-support/runtime/fixture.js';
const exec = promisify(execFile);

describe.skipIf(process.platform !== 'darwin')('runtime directory binding with independent native ACL fixture', () => {
  let f: Awaited<ReturnType<typeof fixture>>; let bootstrap: string; let helper: string;
  beforeAll(async () => {
    f = await fixture();
    bootstrap = await realpath(await mkdtemp(join(tmpdir(), 'gram independent acl ')));
    helper = join(bootstrap, 'file-acl');
    await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      fileURLToPath(new URL('../../../../platform/macos/native/file-acl.c', import.meta.url)), '-o', helper]);
    // This trusted test helper is built separately, outside the candidate bundle.
    f.acl = file => checkMacAcl(file, helper);
  }, 30000);
  afterAll(async () => {
    if (f) { await exec('/bin/chmod', ['-N', join(f.base, 'run')]).catch(() => undefined);
      await rm(f.anchor, { recursive: true, force: true }); }
    if (bootstrap) await rm(bootstrap, { recursive: true, force: true });
  });
  it('validates real descriptors without reading secret contents or changing the tree', async () => {
    const before = await snapshot(f.base);
    const dirs = await inspectRuntimeDirectories(f.layout, f.uid, f.acl, new AbortController().signal);
    await dirs.verify(); expect(await snapshot(f.base)).toEqual(before);
  }, 15000);
  it('binds the real shared record adapter with native ACL checks, without launching Core', async () => {
    const value = await bindReviewedCoreRuntimeAt(f.layout, f.review, f.acl, f.environment, new AbortController().signal);
    expect(value).not.toBeNull(); if (!value) throw new Error('binding');
    const held = await value.execution.acquire('core', 'native-record', f.review.configDigest, f.review.config.releaseDigest);
    expect(await value.execution.read('core')).toMatchObject({ state: 'HELD' });
    await value.execution.release(held);
    expect(await value.execution.read('core')).toMatchObject({ state: 'FREE', revision: 2 });
  }, 30000);
  it('rejects a native ACL write grant even while the directory mode remains 0700', async () => {
    const dirs = await inspectRuntimeDirectories(f.layout, f.uid, f.acl, new AbortController().signal);
    const run = join(f.base, 'run'); await exec('/bin/chmod', ['+a', 'everyone allow write', run]);
    try {
      expect((await stat(run)).mode & 0o7777).toBe(0o700);
      await expect(dirs.verify()).rejects.toThrow('UNSAFE_PATH');
    } finally { await exec('/bin/chmod', ['-N', run]); }
  }, 15000);
});
