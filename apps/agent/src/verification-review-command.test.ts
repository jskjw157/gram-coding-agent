import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolicyEngine } from '@gram/policy';
import { SecretRedactor } from '@gram/secrets';
import type { CommandRequest } from '@gram/shell';
import { createVerificationReviewCommandRunner } from './verification-review-command.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(script: string, options: { timeoutMs?: number; maxOutputBytes?: number; redactor?: SecretRedactor; policy?: PolicyEngine } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gram-review-command-')); roots.push(root);
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n${script}`); chmodSync(join(bin, 'git'), 0o700);
  const commandRuns = { start: vi.fn(() => 1), finish: vi.fn() };
  const approvals = { consume: vi.fn(async () => false) };
  const runner = createVerificationReviewCommandRunner({
    policy: options.policy ?? new PolicyEngine(), approvals, commandRuns, homeDir: root,
    environment: { PATH: bin }, redactor: options.redactor ?? new SecretRedactor(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  });
  const request: CommandRequest = { taskId: 'task-review', cwd: root, category: 'GIT', executable: 'git', args: ['show', 'a'.repeat(40)] };
  return { root, runner, commandRuns, approvals, request };
}

describe('dedicated verification review runner', () => {
  it('returns full in-memory text but stores only omission and hash metadata', async () => {
    const text = 'private ordinary source\n';
    const f = fixture(`process.stdout.write(${JSON.stringify(text)}); process.stderr.write('diagnostic source');`);
    const result = await f.runner.run(f.request);
    expect(result.stdout).toBe(text);
    const stdout = readFileSync(result.stdoutPath, 'utf8');
    const stderr = readFileSync(result.stderrPath, 'utf8');
    expect(stdout).toContain('omitted');
    expect(stdout).toContain(createHash('sha256').update(text).digest('hex'));
    expect(stdout).not.toContain(text);
    expect(stderr).not.toContain('diagnostic source');
    expect(JSON.stringify(f.commandRuns.start.mock.calls)).not.toContain(text);
    expect(f.commandRuns.finish).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'SUCCEEDED', exitCode: 0 }));
  });
  it('redacts returned text without writing raw source or secrets', async () => {
    const secret = 'sensitive-value-fixture';
    const f = fixture(`process.stdout.write(${JSON.stringify(secret)});`, { redactor: new SecretRedactor([secret]) });
    const result = await f.runner.run(f.request);
    expect(result.stdout).not.toContain(secret);
    expect(readFileSync(result.stdoutPath, 'utf8')).not.toContain(secret);
  });
  it.each([
    { shellText: 'git show HEAD; echo raw-source' },
    { executable: 'sh', args: ['-c', 'echo raw-source'] },
    { executable: 'git', args: ['show', '--textconv', 'a'.repeat(40)] },
    { executable: 'git', args: ['show', 'HEAD'] },
    { executable: 'git', args: ['rev-parse', '--verify', `${'a'.repeat(40)}:.env`] },
    { executable: 'git', args: ['diff', '--output=/tmp/escape'] },
  ])('rejects non-fixed commands before persistence %j', async (command) => {
    const f = fixture('process.stdout.write("unexpected");');
    await expect(f.runner.run({ taskId: 'task-review', cwd: f.root, category: 'GIT', ...command } as CommandRequest)).rejects.toThrow();
    expect(f.commandRuns.start).not.toHaveBeenCalled();
  });
  it.each(['stdout', 'stderr'])('kills and rejects overflowing %s without returning a truncated view', async (stream) => {
    const f = fixture(`process.${stream}.write('a'.repeat(1024)); setTimeout(() => require('node:fs').writeFileSync('escaped', ''), 200);`, { maxOutputBytes: 64 });
    await expect(f.runner.run(f.request)).rejects.toThrow(/bound|limit|large/i);
    expect(f.commandRuns.finish).toHaveBeenCalledWith(1, { status: 'FAILED', exitCode: null });
    expect(existsSync(join(f.root, 'escaped'))).toBe(false);
  });
  it('kills and rejects timed out processes after exit', async () => {
    const f = fixture("setInterval(() => {}, 100);", { timeoutMs: 40 });
    await expect(f.runner.run(f.request)).rejects.toThrow(/timed out|timeout/i);
    expect(f.commandRuns.finish).toHaveBeenCalledWith(1, { status: 'FAILED', exitCode: null });
  });
  it.each(['stdout', 'stderr'])('rejects invalid UTF-8 in %s', async (stream) => {
    const f = fixture(`process.${stream}.write(Buffer.from([0xff]));`);
    await expect(f.runner.run(f.request)).rejects.toThrow(/UTF-8/i);
  });
  it('preserves valid UTF-8 split across chunks and the BOM exactly', async () => {
    const f = fixture("process.stdout.write(Buffer.from([0xef,0xbb,0xbf,0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82,0xac])), 10);");
    expect((await f.runner.run(f.request)).stdout).toBe('\uFEFF€');
  });
});

it('honors existing policy approval denial before spawning or recording a command', async () => {
  const policy = new PolicyEngine();
  vi.spyOn(policy, 'evaluate').mockReturnValue({ kind: 'NEEDS_APPROVAL', ruleId: 'fixture-review-policy', operationHash: 'fixture-operation', reason: 'Approval unavailable' });
  const f = fixture('process.stdout.write("must not execute");', { policy });
  await expect(f.runner.run(f.request)).rejects.toThrow('Approval unavailable');
  expect(f.approvals.consume).toHaveBeenCalledWith('task-review', 'fixture-operation');
  expect(f.commandRuns.start).not.toHaveBeenCalled();
});
