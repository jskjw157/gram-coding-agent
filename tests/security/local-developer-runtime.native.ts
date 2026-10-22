import { afterEach, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { localDeveloperFixture, cleanupLocalDeveloperFixtures } from '../../apps/agent/src/local-developer-runtime.test-support.js';
afterEach(cleanupLocalDeveloperFixtures);
  it('runs a real named npm command through M5 isolation and persists its outcome', async () => {
    const f = localDeveloperFixture();await f.runtime.register({ root: 'fixture', path: '.' });
    const result = await f.runtime.run({ repositoryId: 7, command: 'test', timeoutMs: 10_000 });
    expect(result.status).toBe('SUCCEEDED');expect(result.stdout).toContain('12345');
    expect(f.tasks.get(result.taskId)).toMatchObject({ taskType: 'LOCAL_COMMAND', status: 'COMPLETED' });
    expect(f.db.prepare('SELECT * FROM verification_plans').all()).toEqual([]);
  }, 30_000);
it('screens project credentials from real command output before log persistence and response', async () => {
  const f = localDeveloperFixture();
  writeFileSync(join(f.base, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "console.log(\'PASSWORD=fixture-private\')"' } }));
  f.git(['add', '--', 'package.json']);f.git(['commit', '-m', 'fixture credential output']);
  await f.runtime.register({ root: 'fixture', path: '.' });
  const result = await f.runtime.run({ repositoryId: 7, command: 'test', timeoutMs: 10_000 });
  expect(result.status).toBe('SUCCEEDED');expect(result.stdout).not.toContain('fixture-private');
  const row = f.db.prepare('SELECT stdout_path AS path FROM command_runs WHERE id = ?').get(result.commandRunId) as { path: string };
  expect(readFileSync(row.path, 'utf8')).not.toContain('fixture-private');
}, 30_000);
