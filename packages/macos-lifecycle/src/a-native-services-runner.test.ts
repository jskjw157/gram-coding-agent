import type { ExecFileException, ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSystemLaunchctlRunner, createSystemServiceHandle } from './a-native-services.js';
import { createLaunchctlServices, launchctlVector, type LaunchctlAction, type LaunchctlObservation } from './adapters/launchctl.js';
import { labels, type Role } from './contracts.js';
import type { InstallResult } from './installation-transaction/contracts.js';

type ExecPort = (file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding,
  callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void) => void;
const processes = vi.hoisted(() => ({ execFile: vi.fn<ExecPort>() }));
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(), execFile: processes.execFile,
}));

interface Reply {
  afterMs: number | null;
  error?: ExecFileException | null;
  stdout?: string | Buffer;
  stderr?: string | Buffer;
}
function failure(fields: Record<string, unknown> = {}): ExecFileException {
  return Object.assign(new Error('SYNTHETIC_PRIVATE_PROCESS_ERROR'), { cmd: '/bin/launchctl' }, fields);
}
function present(role: Role): Reply { return { afterMs: 0, stdout: `system/${labels[role]} = {\n}\n` }; }
function absent(role: Role): Reply {
  return { afterMs: 0, error: failure({ code: 113 }), stderr: `Could not find service "${labels[role]}" in domain for system\n` };
}
/** Model execFile's callback deadline independently from the service adapter. */
function harness(reply: (argv: readonly string[], call: number) => Reply) {
  const seen: Array<{ argv: readonly string[]; options: ExecFileOptionsWithStringEncoding }> = [];
  processes.execFile.mockImplementation((file, args, options, callback) => {
    const argv = [file, ...args]; seen.push({ argv, options });
    const result = reply(argv, seen.length);
    if (typeof options.timeout !== 'number' || !Number.isFinite(options.timeout) || options.timeout <= 0) {
      throw new Error('EXPECTED_BOUNDED_COMMAND');
    }
    let completion: ReturnType<typeof setTimeout> | undefined; let settled = false;
    const finish = (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); clearTimeout(completion); callback(error, stdout, stderr);
    };
    const timeout = setTimeout(() => finish(failure({ killed: true, signal: 'SIGKILL', code: null }),
      '', 'SYNTHETIC_PRIVATE_TIMEOUT'), options.timeout);
    if (result.afterMs !== null) {
      const complete = () => finish(result.error ?? null, result.stdout ?? '', result.stderr ?? '');
      if (result.afterMs === 0) void Promise.resolve().then(complete);
      else completion = setTimeout(complete, result.afterMs);
    }
  });
  return seen;
}
const commands = (seen: ReturnType<typeof harness>) => seen.map(call => call.argv);

beforeEach(() => { vi.useFakeTimers(); processes.execFile.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('fixed launchctl stop completion window', () => {
  it.each([
    { source: 'system handle', role: 'core' as const },
    { source: 'launchctl adapter', role: 'tunnel' as const },
  ])('waits for a seven-second $role shutdown through the $source and then proves absence', async ({ source, role }) => {
    let stopped = false; let result: InstallResult | undefined;
    const seen = harness(argv => {
      if (argv[1] === 'print') return stopped ? absent(role) : present(role);
      if (argv[1] === 'bootout') {
        // The daemon's drain is independent of the launchctl client's lifetime.
        setTimeout(() => { stopped = true; }, 7000);
        return { afterMs: 7000 };
      }
      return { afterMs: 0 };
    });
    const services = source === 'system handle'
      ? createSystemServiceHandle(async () => true) : createLaunchctlServices(createSystemLaunchctlRunner());
    const work = services.stop(role).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(6999);
    expect(result).toBeUndefined();
    expect(commands(seen)).toEqual(['print', 'disable', 'bootout'].map(action => launchctlVector(action as LaunchctlAction, role)));
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(result).toEqual({ ok: true, code: 'OK' });
    expect(commands(seen)).toEqual(['print', 'disable', 'bootout', 'print'].map(action => launchctlVector(action as LaunchctlAction, role)));
    expect(seen.map(call => call.options.timeout)).toEqual([5000, 5000, 30000, 5000]);
  });

  it('fails a hung bootout at the shared thirty-second deadline without dispatching a later print', async () => {
    let result: InstallResult | undefined;
    const seen = harness(argv => argv[1] === 'print' ? present('core') : { afterMs: argv[1] === 'bootout' ? null : 0 });
    const work = createSystemServiceHandle(async () => true).stop('core').then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(29999);
    expect(result).toBeUndefined(); expect(seen).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(result).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expect(commands(seen)).toEqual(['print', 'disable', 'bootout'].map(action => launchctlVector(action as LaunchctlAction, 'core')));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it.each(['print', 'disable', 'enable', 'bootstrap'] as const)('keeps %s bounded at five seconds', async action => {
    const seen = harness(() => ({ afterMs: null })); let result: LaunchctlObservation | undefined;
    const work = createSystemLaunchctlRunner()(launchctlVector(action, 'core')).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(4999); expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(result?.code).toBe(255); expect(seen[0]?.options.timeout).toBe(5000);
  });

  it.each([
    { name: 'label suffix', argv: ['/bin/launchctl', 'bootout', `system/${labels.core}.extra`] },
    { name: 'user domain', argv: ['/bin/launchctl', 'bootout', `gui/501/${labels.core}`] },
    { name: 'extra argument', argv: ['/bin/launchctl', 'bootout', `system/${labels.core}`, 'extra'] },
    { name: 'plist path', argv: ['/bin/launchctl', 'bootout', 'system', `/Library/LaunchDaemons/${labels.core}.plist`] },
  ])('does not extend the deadline of a bootout vector with $name', async ({ argv }) => {
    const seen = harness(() => ({ afterMs: null })); let result: LaunchctlObservation | undefined;
    const work = createSystemLaunchctlRunner()(argv).then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(4999); expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(result?.code).toBe(255); expect(seen[0]?.options.timeout).toBe(5000);
  });
});

describe('launchctl process result normalization', () => {
  it.each([
    { name: 'timeout', fields: { code: null, killed: true, signal: 'SIGKILL' } },
    { name: 'signal', fields: { code: null, signal: 'SIGTERM' } },
    { name: 'killed numeric failure', fields: { code: 1, killed: true, signal: null } },
    { name: 'signaled numeric failure', fields: { code: 2, signal: 'SIGTERM' } },
    { name: 'ENOENT', fields: { code: 'ENOENT' } },
    { name: 'missing code', fields: {} },
    { name: 'null code', fields: { code: null } },
    { name: 'string numeric code', fields: { code: '113' } },
    { name: 'zero error code', fields: { code: 0 } },
    { name: 'negative code', fields: { code: -1 } },
    { name: 'out-of-range code', fields: { code: 256 } },
    { name: 'fractional code', fields: { code: 1.5 } },
    { name: 'NaN code', fields: { code: Number.NaN } },
  ])('normalizes $name to closed code 255', async ({ fields }) => {
    harness(() => ({ afterMs: 0, error: failure(fields), stdout: 'retained stdout', stderr: 'retained stderr' }));
    const work = createSystemLaunchctlRunner()(launchctlVector('enable', 'core'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await work).toEqual({ code: 255, stdout: 'retained stdout', stderr: 'retained stderr' });
  });

  it.each([1, 113, 255])('retains an actual numeric process failure %i', async code => {
    harness(() => ({ afterMs: 0, error: failure({ code, killed: false, signal: null }), stdout: 'stdout', stderr: 'stderr' }));
    const work = createSystemLaunchctlRunner()(launchctlVector('print', 'core'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await work).toEqual({ code, stdout: 'stdout', stderr: 'stderr' });
  });

  it('returns zero only for an error-free callback and preserves the fixed process options', async () => {
    const seen = harness(() => ({ afterMs: 0, stdout: 'stdout', stderr: 'stderr' }));
    const work = createSystemLaunchctlRunner()(launchctlVector('bootout', 'core'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await work).toEqual({ code: 0, stdout: 'stdout', stderr: 'stderr' });
    expect(seen[0]).toEqual({ argv: launchctlVector('bootout', 'core'), options: {
      encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, shell: false,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' },
    } });
  });

  it('does not stringify non-text output or expose a synchronous process error', async () => {
    harness(() => ({ afterMs: 0, stdout: Buffer.from('SYNTHETIC_PRIVATE_STDOUT'), stderr: Buffer.from('SYNTHETIC_PRIVATE_STDERR') }));
    const work = createSystemLaunchctlRunner()(launchctlVector('print', 'core'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await work).toEqual({ code: 0, stdout: '', stderr: '' });
    processes.execFile.mockImplementation(() => { throw failure(); });
    expect(await createSystemLaunchctlRunner()(launchctlVector('print', 'core'))).toEqual({ code: 255, stdout: '', stderr: '' });
  });

  it.each([
    { name: 'wrong executable', argv: ['/usr/bin/env', 'print', `system/${labels.core}`] },
    { name: 'too few arguments', argv: ['/bin/launchctl', 'print'] },
    { name: 'empty argument', argv: ['/bin/launchctl', '', `system/${labels.core}`] },
    { name: 'oversized argument', argv: ['/bin/launchctl', 'print', 'x'.repeat(4097)] },
    { name: 'too many arguments', argv: ['/bin/launchctl', 'bootout', `system/${labels.core}`, 'extra', 'extra'] },
  ])('preserves command validation for $name without execution', async ({ argv }) => {
    expect(await createSystemLaunchctlRunner()(argv)).toEqual({ code: 255, stdout: '', stderr: '' });
    expect(processes.execFile).not.toHaveBeenCalled();
  });
});

describe('system service handle retains strict launchctl stop semantics', () => {
  it('does not mutate an initially absent job', async () => {
    const seen = harness(() => absent('core'));
    const work = createSystemServiceHandle(async () => true).stop('core');
    await vi.advanceTimersByTimeAsync(0);
    expect(await work).toEqual({ ok: true, code: 'OK' });
    expect(commands(seen)).toEqual([launchctlVector('print', 'core')]);
  });

  it.each([
    { name: 'permission', reply: { afterMs: 0, error: failure({ code: 1 }), stderr: 'Operation not permitted SYNTHETIC_PRIVATE' }, code: 'NOT_AUTHORIZED' },
    { name: 'parse', reply: { afterMs: 0, stdout: 'SYNTHETIC_PRIVATE_PARSE' }, code: 'FOREIGN_SERVICE' },
  ])('does not mutate after an initial $name failure', async ({ reply, code }) => {
    const seen = harness(() => reply);
    const work = createSystemServiceHandle(async () => true).stop('core');
    await vi.advanceTimersByTimeAsync(0); const result = await work;
    expect(result).toEqual({ ok: false, code }); expect(commands(seen)).toEqual([launchctlVector('print', 'core')]);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it('does not upgrade a completed bootout with final still present to success', async () => {
    const seen = harness(argv => argv[1] === 'print' ? present('core') : { afterMs: 0 });
    let result: InstallResult | undefined;
    const work = createSystemServiceHandle(async () => true).stop('core').then(value => { result = value; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(result).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expect(commands(seen).slice(0, 4)).toEqual(['print', 'disable', 'bootout', 'print']
      .map(action => launchctlVector(action as LaunchctlAction, 'core')));
    expect(commands(seen).slice(4)).toEqual(seen.slice(4).map(() => launchctlVector('print', 'core')));
    expect(seen.slice(3).map(call => call.options.timeout)).toEqual(Array.from({ length: 150 }, () => 5000));
    expect(vi.getTimerCount()).toBe(0);
    const count = seen.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toHaveLength(count);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it.each([
    { name: 'parse error', reply: { afterMs: 0, stdout: 'SYNTHETIC_PRIVATE_PARSE' }, code: 'PARTIAL_INSTALL' },
    { name: 'inexact absence', reply: { ...absent('core'), stderr: `Could not find service "${labels.core}" in domain for system\nextra\n` }, code: 'PARTIAL_INSTALL' },
    { name: 'permission error', reply: { afterMs: 0, error: failure({ code: 1 }), stderr: 'Operation not permitted SYNTHETIC_PRIVATE' }, code: 'NOT_AUTHORIZED' },
  ])('does not upgrade a completed bootout with final $name to success', async ({ reply, code }) => {
    let prints = 0;
    const seen = harness(argv => argv[1] === 'print' ? ++prints === 1 ? present('core') : reply : { afterMs: 0 });
    const work = createSystemServiceHandle(async () => true).stop('core');
    await vi.advanceTimersByTimeAsync(0); const result = await work;
    expect(result).toEqual({ ok: false, code });
    expect(commands(seen)).toEqual(['print', 'disable', 'bootout', 'print'].map(action => launchctlVector(action as LaunchctlAction, 'core')));
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });

  it('does not bootstrap after an enable spawn failure or expose its error text', async () => {
    const seen = harness(() => ({ afterMs: 0, error: failure({ code: 'ENOENT' }), stderr: 'SYNTHETIC_PRIVATE_STDERR' }));
    const work = createSystemServiceHandle(async () => true).start('core');
    await vi.advanceTimersByTimeAsync(0); const result = await work;
    expect(result).toEqual({ ok: false, code: 'PARTIAL_INSTALL' });
    expect(commands(seen)).toEqual([launchctlVector('enable', 'core')]); expect(JSON.stringify(result)).not.toContain('SYNTHETIC');
  });
});
