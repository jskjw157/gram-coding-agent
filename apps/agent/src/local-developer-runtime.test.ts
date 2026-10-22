import { writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { assertTrustedRuntime, RUNTIME_ROOT } from '@gram/shell';
import { localDeveloperFixture, cleanupLocalDeveloperFixtures } from './local-developer-runtime.test-support.js';
afterEach(cleanupLocalDeveloperFixtures);
beforeAll(() => assertTrustedRuntime(RUNTIME_ROOT), 30_000);
describe('local developer runtime with real temporary Git and SQLite', () => {
  it('reads Git and registers inspected GitHub identity plus declared profile', async () => {
    const f = localDeveloperFixture();expect(await f.runtime.status({ root: 'fixture', path: '.' })).toEqual({ entries: [], truncated: false });
    expect((await f.runtime.log({ root: 'fixture', path: '.', maxCount: 1 })).commits[0]?.subject).toBe('fixture initial');
    expect(await f.runtime.register({ root: 'fixture', path: '.' })).toEqual({ repositoryId: 7 });
    expect(f.repositories.getById(7)).toMatchObject({ localBasePath: f.base, commands: { test: 'npm run test' }, packageManager: 'npm' });
    writeFileSync(join(f.base, 'package-lock.json'), 'changed');
    expect((await f.runtime.diff({ root: 'fixture', path: '.', staged: false })).diff).toContain('+changed');
  });
  it('rejects dirty base commands before creating a task', async () => {
    const f = localDeveloperFixture();await f.runtime.register({ root: 'fixture', path: '.' });writeFileSync(join(f.base, 'untracked'), 'fixture');
    await expect(f.runtime.run({ repositoryId: 7, command: 'test', timeoutMs: 1000 })).rejects.toThrow();
    expect(f.db.prepare('SELECT * FROM tasks').all()).toEqual([]);
  });
  it('refuses a symlinked package profile without reading or persisting its target', async () => {
    const f = localDeveloperFixture();rmSync(join(f.base, 'package.json'));symlinkSync('/outside/fixture-private', join(f.base, 'package.json'));
    await expect(f.runtime.register({ root: 'fixture', path: '.' })).rejects.toThrow();expect(f.repositories.getById(7)).toBeUndefined();
  });
  it('withholds credential-bearing diff bodies from the MCP-facing result', async () => {
    const f = localDeveloperFixture();writeFileSync(join(f.base, 'config.json'), '{"password":"fixture-private"}');
    f.git(['add', '--', 'config.json']);f.git(['commit', '-m', 'fixture config']);
    writeFileSync(join(f.base, 'config.json'), '{"password":"fixture-updated"}');
    const result = await f.runtime.diff({ root: 'fixture', path: '.', staged: false });
    expect(result.diff).not.toContain('fixture-private');expect(result.diff).not.toContain('fixture-updated');
    expect(result.diff).toContain('REDACTED');
  });
  it('preserves the registered profile when a live Task or lease blocks registration', async () => {
    const f = localDeveloperFixture();await f.runtime.register({ root: 'fixture', path: '.' });
    const original = f.repositories.getById(7);f.denyRegistration();
    writeFileSync(join(f.base, 'package.json'), JSON.stringify({ scripts: { build: 'node fixture.js' } }));
    await expect(f.runtime.register({ root: 'fixture', path: '.' })).rejects.toThrow();
    expect(f.repositories.getById(7)).toEqual(original);
  });

});
