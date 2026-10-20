import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '@gram/policy';
import { FileSecretProvider, SecretRedactor } from '@gram/secrets';
import { TrustedGitSpawner } from './trusted-git-spawner.js';
import { createVerificationReviewCommandRunner } from './verification-review-command.js';

let root: string;
let base: string;
const git = (args: string[]) => execFileSync('/usr/bin/git', args, {
  cwd: base, encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
});
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gram-review-guarded-'));
  base = join(root, 'base'); mkdirSync(base);
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@localhost.invalid']);
  git(['remote', 'add', 'origin', 'https://github.com/fixture/smoke.git']);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
function fixture(content: string | Buffer) {
  writeFileSync(join(base, 'counter.ts'), content);
  git(['add', '--', 'counter.ts']);
  git(['commit', '-m', 'fixture']);
  const oid = git(['rev-parse', 'HEAD:counter.ts']).trim();
  const secrets = new FileSecretProvider(join(root, 'absent-secrets'));
  const credentialRead = vi.spyOn(secrets, 'getForUse');
  const commandRuns = { start: vi.fn(() => 1), finish: vi.fn() };
  const runner = createVerificationReviewCommandRunner({
    spawner: new TrustedGitSpawner({
      contextForTask: (taskId) => {
        if (taskId !== 'review-task') throw new Error('Unknown task');
        return { basePath: base, owner: 'fixture', name: 'smoke' };
      },
      secrets, execution: { strictUtf8: true, timeoutMs: 10_000, maxOutputBytes: 1024 },
    }),
    policy: new PolicyEngine(), approvals: { consume: async () => false },
    commandRuns, homeDir: root, redactor: new SecretRedactor(),
  });
  const run = () => runner.run({ taskId: 'review-task', cwd: base, category: 'GIT', executable: 'git', args: ['show', oid] });
  return { run, commandRuns, credentialRead };
}
describe('review runner composed with the trusted Git process port', () => {
  it('reads a real Git blob and persists only metadata without acquiring credentials', async () => {
    const source = 'export const counter = 2;\n';
    const f = fixture(source);
    const result = await f.run();
    expect(result.stdout).toBe(source);
    expect(result.exitCode).toBe(0);
    const metadata = JSON.parse(readFileSync(result.stdoutPath, 'utf8'));
    expect(metadata).toMatchObject({ omitted: 'verification review source', bytes: Buffer.byteLength(source) });
    expect(readFileSync(result.stdoutPath, 'utf8')).not.toContain(source);
    expect(f.credentialRead).not.toHaveBeenCalled();
    expect(f.commandRuns.finish).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'SUCCEEDED' }));
  });
  it('rejects hostile local Git configuration before a helper can execute', async () => {
    const f = fixture('ordinary source');
    const marker = join(root, 'helper-ran');
    const helper = join(root, 'helper');
    writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    git(['config', 'core.fsmonitor', helper]);
    await expect(f.run()).rejects.toThrow();
    expect(existsSync(marker)).toBe(false);
    expect(f.credentialRead).not.toHaveBeenCalled();
    expect(f.commandRuns.finish).toHaveBeenCalledWith(1, { status: 'FAILED', exitCode: null });
  });
  it.each([
    ['oversized', 'x'.repeat(8192), /execution failed/],
    ['invalid UTF-8', Buffer.from([0xff]), /UTF-8/],
  ] as const)('refuses %s actual Git blob output without persisting a source view', async (_name, bytes, error) => {
    const f = fixture(bytes);
    await expect(f.run()).rejects.toThrow(error);
    expect(f.credentialRead).not.toHaveBeenCalled();
    expect(f.commandRuns.finish).toHaveBeenCalledWith(1, { status: 'FAILED', exitCode: null });
    expect(existsSync(join(root, '.gram-agent', 'logs', 'tasks', 'review-task', 'cmd-1.stdout'))).toBe(false);
  });
});
