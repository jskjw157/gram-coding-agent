import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, chmod, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkMacAcl } from './macos-acl.js';
import { createTelemetryFilesAt } from './telemetry-files.js';
import { TelemetryStore } from '../telemetry-store.js';
const exec = promisify(execFile);
describe.skipIf(process.platform !== 'darwin')('native ACL telemetry fixtures, never installed', () => {
  let dir: string; let helper: string; let store: TelemetryStore;
  const owner = { role: 'core' as const, generation: 'gen-native-1', releaseDigest: 'a'.repeat(64) };
  const event = (observedAtMs: number) => ({ schemaVersion: 1, ...owner, code: 'OK', observedAtMs, attemptCount: 0 });
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), 'gram native telemetry '))); await chmod(dir, 0o700);
    helper = join(dir, 'file-acl');
    await exec('/usr/bin/xcrun', ['clang', '-std=c11', '-Wall', '-Wextra', '-Werror',
      fileURLToPath(new URL('../../../../platform/macos/native/file-acl.c', import.meta.url)), '-o', helper]);
    await mkdir(join(dir, 'run'), { mode: 0o700 }); await mkdir(join(dir, 'logs'), { mode: 0o700 });
    const policy = (relative: string) => ({ anchor: dir, relative, ancestorUid: process.getuid?.() ?? -1,
      stateUid: process.getuid?.() ?? -1, acl: (fd: import('node:fs/promises').FileHandle) => checkMacAcl(fd, helper) });
    const files = createTelemetryFilesAt(policy('run'), policy('logs')); store = new TelemetryStore(files.status, files.events);
  }, 30000);
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  it('persists and reloads private status and structured events with the real descriptor ACL helper', async () => {
    await store.writeStatus('core', { ...event(1000), state: 'LOCAL_CORE_HEALTHY' }, owner);
    await store.appendEvent('core', event(1000));
    expect((await store.readStatus('core', owner, 1001))?.state).toBe('LOCAL_CORE_HEALTHY');
    expect((await readFile(join(dir, 'logs/core.events.0.jsonl'), 'utf8')).split('\n')).toHaveLength(3);
  });
  it('refuses an actual allow-write log ACL without overwriting its bytes', async () => {
    await store.appendEvent('tunnel', { ...event(1000), role: 'tunnel' });
    const path = join(dir, 'logs/tunnel.events.0.jsonl'); const prior = await readFile(path);
    await exec('/bin/chmod', ['+a', 'everyone allow write', path]);
    try {
      await expect(store.appendEvent('tunnel', { ...event(2000), role: 'tunnel' })).rejects.toThrow(/^UNSAFE_PATH$/);
      expect((await readFile(path)).equals(prior)).toBe(true);
    } finally { await exec('/bin/chmod', ['-N', path]); }
  });
});
