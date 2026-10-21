import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkMacAcl } from './macos-acl.js';
import { createCircuitFilesAt } from './service-files.js';
import { LifecycleStore } from '../lifecycle-store.js';
const exec = promisify(execFile);

describe.skipIf(process.platform !== 'darwin')('real Apple ACL and circuit persistence, never installed', () => {
  let anchor: string; let helper: string;
  beforeAll(async () => {
    anchor = await realpath(await mkdtemp(join(tmpdir(), 'gram circuit native ')));
    helper = join(anchor, 'file-acl');
    await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      fileURLToPath(new URL('../../../../platform/macos/native/file-acl.c', import.meta.url)), '-o', helper]);
  }, 30000);
  afterAll(async () => { if (anchor) await rm(anchor, { recursive: true, force: true }); });
  async function fixture(name: string) {
    await mkdir(join(anchor, name), { mode: 0o700 });
    return new LifecycleStore(createCircuitFilesAt({ anchor, relative: name,
      ancestorUid: process.getuid?.() ?? -1, stateUid: process.getuid?.() ?? -1,
      acl: fd => checkMacAcl(fd, helper) }));
  }
  it('writes, syncs and recovers using the actual native descriptor verifier', async () => {
    const store = await fixture('roundtrip');
    let h = await store.initializeNew('core', 1);
    await store.write('core', h, { kind: 'begin', generation: 'native-g1', nowMs: 2 });
    h = await store.write('core', await store.read('core'), { kind: 'recover', nowMs: 3 });
    expect(h.history.exitsMs).toEqual([3]); expect(h.history.activeAttempt).toBeNull();
  }, 30000);
  it('refuses an actual ACL write grant and preserves existing record bytes', async () => {
    const store = await fixture('refusal'); const h = await store.initializeNew('core', 1);
    const path = join(anchor, 'refusal', 'core.circuit.json'); const before = await readFile(path);
    await exec('/bin/chmod', ['+a', 'everyone allow write', path]);
    try {
      await expect(store.read('core')).rejects.toThrow(/^UNSAFE_PATH$/);
      await expect(store.write('core', h, { kind: 'begin', generation: 'not-started', nowMs: 2 })).rejects.toThrow(/^UNSAFE_PATH$/);
      expect(await readFile(path)).toEqual(before);
    } finally { await exec('/bin/chmod', ['-N', path]); }
  }, 30000);
});
