import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLocalJob } from './job.js';

const roots: string[] = [];
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'gram-local-job-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local JSON job entry point', () => {
  it('runs an ordered file/code/file job and returns in-memory evidence', async () => {
    const result = await runLocalJob(
      {
        operations: [
          { op: 'write_text', path: 'answer.cjs', content: "require('node:fs').writeFileSync('answer.txt', '42');" },
          { op: 'run_node', path: 'answer.cjs', args: [] },
          { op: 'read_text', path: 'answer.txt' },
        ],
      },
      { workspace: workspace(), trustedLocalCode: true },
    );
    expect(result.results).toEqual([
      { op: 'write_text', written: true },
      { op: 'run_node', commandRunId: 1, exitCode: 0, stdout: '', stderr: '' },
      { op: 'read_text', content: '42' },
    ]);
    expect(result.executionIsolation).toBe('HOST_PROCESS_NOT_OS_SANDBOXED');
    expect(result.runs).toEqual([{ id: 1, status: 'SUCCEEDED', exitCode: 0 }]);
  });

  it('validates the whole job before changing files', async () => {
    const root = workspace();
    await expect(
      runLocalJob(
        {
          operations: [
            { op: 'write_text', path: 'before.txt', content: 'changed' },
            { op: 'run_shell', command: 'echo unsafe' },
          ],
        },
        { workspace: root },
      ),
    ).rejects.toThrow('Invalid local operation');
    expect(existsSync(join(root, 'before.txt'))).toBe(false);
  });

  it('refuses jobs containing code before changing files when opt-in is absent', async () => {
    const root = workspace();
    await expect(
      runLocalJob(
        {
          operations: [
            { op: 'write_text', path: 'before.txt', content: 'changed' },
            { op: 'run_node', path: 'before.txt' },
          ],
        },
        { workspace: root },
      ),
    ).rejects.toThrow('trusted local code');
    expect(existsSync(join(root, 'before.txt'))).toBe(false);
  });
});
