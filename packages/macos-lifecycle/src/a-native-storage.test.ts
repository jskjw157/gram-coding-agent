import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createNativeInstallStorageAt } from './a-native-storage.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const anchor = await mkdtemp(join(tmpdir(), 'gram-native-storage-'));
  roots.push(anchor);
  const uid = process.getuid?.() ?? 0;
  await chmod(anchor, 0o700);
  await mkdir(join(anchor, 'app/config'), { recursive: true, mode: 0o700 });
  await mkdir(join(anchor, 'Library/LaunchDaemons'), { recursive: true, mode: 0o700 });
  const storage = createNativeInstallStorageAt({
    anchor,
    ownerUid: uid,
    appRelative: 'app',
    launchdRelative: 'Library/LaunchDaemons',
    acl: async () => true,
  });
  return { anchor, storage };
}

describe('A fixed native install storage', () => {
  const restrictiveUmaskCase = 'writes readable metadata while retaining a restrictive inherited umask';
  it(restrictiveUmaskCase, async () => {
    // umask is process-wide. Only the dedicated child changes it, so parallel
    // test workers and the rest of this suite keep their original permissions.
    if (process.env.GRAM_TEST_METADATA_UMASK !== '077') {
      const cli = new URL('vitest.mjs', import.meta.resolve('vitest/package.json'));
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        process.umask(0o077);
        process.env.GRAM_TEST_METADATA_UMASK = '077';
        process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))},
          'run', 'src/a-native-storage.test.ts', '--testNamePattern',
          ${JSON.stringify(restrictiveUmaskCase)}, '--maxWorkers', '1'];
        await import(${JSON.stringify(cli.href)});
      `], {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        encoding: 'utf8',
        timeout: 20_000,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stdout + child.stderr).toBe(0);
      return;
    }

    expect(process.umask()).toBe(0o077);
    const f = await fixture();
    const lock = await f.storage.lock();
    expect(lock.acquired).toBe(true);
    try {
      expect((await stat(`${f.anchor}/app/config/install.lock`)).mode & 0o7777).toBe(0o600);
      const prepared = Buffer.from('{"schemaVersion":1,"stage":"PREPARED"}');
      await f.storage.journal.writeStage('PREPARED', prepared);
      expect(await f.storage.journal.read()).toEqual(prepared);

      const files = [
        ['configuration', 'app/config/service.json'],
        ['manifest', 'app/config/installation.json'],
        ['core', 'Library/LaunchDaemons/com.haar.gram-agent.core.plist'],
        ['tunnel', 'Library/LaunchDaemons/com.haar.gram-agent.tunnel.plist'],
      ] as const;
      const bytes = Buffer.from('nonsecret-metadata');
      for (const [kind, relative] of files) {
        await f.storage.publish.stageFile(kind, bytes);
        await f.storage.publish.publishFile(kind, bytes);
        expect(await f.storage.publish.readLive(kind)).toEqual(bytes);
        const published = await stat(join(f.anchor, relative));
        expect(published.mode & 0o7777).toBe(0o644);
        expect(published.uid).toBe(process.getuid?.() ?? 0);
        expect(published.nlink).toBe(1);
      }
      expect((await stat(`${f.anchor}/app/config/install-journal.json`)).mode & 0o7777).toBe(0o644);
      expect(process.umask()).toBe(0o077);
    } finally {
      await lock.release();
    }
  });

  it('stages and publishes exact fixed files without caller-selected paths', async () => {
    const f = await fixture();
    const bytes = Buffer.from('{"schemaVersion":1}');
    await f.storage.publish.stageFile('configuration', bytes);
    expect(await f.storage.publish.readStaged('configuration')).toEqual(bytes);
    expect(await f.storage.publish.readLive('configuration')).toBeNull();

    await f.storage.publish.publishFile('configuration', bytes);
    expect(await f.storage.publish.readStaged('configuration')).toBeNull();
    expect(await f.storage.publish.readLive('configuration')).toEqual(bytes);
    expect(await f.storage.presence('configuration')).toBe('file');
  });

  it('publishes nonsecret service metadata as owner-writable but runtime-readable 0644', async () => {
    const f = await fixture();
    const bytes = Buffer.from('metadata');
    for (const kind of ['configuration', 'manifest', 'journal', 'core'] as const) {
      await f.storage.publish.stageFile(kind, bytes);
      await f.storage.publish.publishFile(kind, bytes);
    }
    expect((await stat(`${f.anchor}/app/config/service.json`)).mode & 0o777).toBe(0o644);
    expect((await stat(`${f.anchor}/app/config/installation.json`)).mode & 0o777).toBe(0o644);
    expect((await stat(`${f.anchor}/app/config/install-journal.json`)).mode & 0o777).toBe(0o644);
    expect((await stat(`${f.anchor}/Library/LaunchDaemons/com.haar.gram-agent.core.plist`)).mode & 0o777).toBe(0o644);
  });

  it('uses a durable fixed install lock and never steals an existing lock', async () => {
    const f = await fixture();
    const first = await f.storage.lock();
    expect(first.acquired).toBe(true);
    const second = await f.storage.lock();
    expect(second.acquired).toBe(false);
    await first.release();

    const third = await f.storage.lock();
    expect(third.acquired).toBe(true);
    await third.release();
  });

  it('atomically replaces the live journal while preserving staged committed bytes', async () => {
    const f = await fixture();
    const committed = Buffer.from('{"schemaVersion":1,"stage":"COMMITTED","installationDigest":"' + 'a'.repeat(64) + '"}');
    const intermediate = Buffer.from('{"schemaVersion":1,"stage":"PUBLISHED"}');

    await f.storage.publish.stageFile('journal', committed);
    await f.storage.journal.writeStage('PUBLISHED', intermediate);
    expect(await f.storage.journal.read()).toEqual(intermediate);
    expect(await f.storage.publish.readStaged('journal')).toEqual(committed);

    await f.storage.publish.publishFile('journal', committed);
    expect(await f.storage.journal.read()).toEqual(committed);
  });

  it('refuses a second stage instead of deleting crash evidence', async () => {
    const f = await fixture();
    await f.storage.publish.stageFile('core', Buffer.from('first'));
    await expect(f.storage.publish.stageFile('core', Buffer.from('second'))).rejects.toBeDefined();
    expect(await f.storage.publish.readStaged('core')).toEqual(Buffer.from('first'));
  });

  it('removes only a byte-identical manifest-owned plist', async () => {
    const f = await fixture();
    const owned = Buffer.from('owned-plist');
    await f.storage.publish.stageFile('core', owned);
    await f.storage.publish.publishFile('core', owned);

    expect(await f.storage.removeLiveIfMatches('core', Buffer.from('other'))).toBe(false);
    expect(await f.storage.publish.readLive('core')).toEqual(owned);
    expect(await f.storage.removeLiveIfMatches('core', owned)).toBe(true);
    expect(await f.storage.publish.readLive('core')).toBeNull();
    expect(await f.storage.removeLiveIfMatches('core', owned)).toBe(true);
  });
});
