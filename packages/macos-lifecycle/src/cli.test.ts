import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliDeps, DiagnosticEvidence } from './cli-contracts.js';
import type { Preview, Result } from './contracts.js';
import { configDigest } from './config.js';
import { runCli } from './cli.js';
import { makeCliFixture, mutationArgs } from './test-support/cli/fixture.js';

function output(lines: string[]): unknown {
  expect(lines).toHaveLength(1); expect(lines[0]).toMatch(/\n$/);
  return JSON.parse(lines[0] ?? '');
}
function failure(action: string | null, code: string) {
  return { schemaVersion: 1, mode: 'LAB_ONLY', action, businessReadiness: 'UNAVAILABLE', result: { ok: false, code } };
}

describe('strict local lifecycle CLI', () => {
  it.each([{ args: [] }, { args: ['preview', '--json'] }])('defaults only to read-only preview (%j)', async ({ args }) => {
    const f = await makeCliFixture();
    expect(await runCli(args, f.deps)).toBe(0);
    expect(f.calls).toEqual(['preview']); expect(f.requests).toEqual([]);
    expect(output(f.lines)).toEqual({ schemaVersion: 1, mode: 'LAB_ONLY', action: 'preview',
      businessReadiness: 'UNAVAILABLE', preview: f.previewResult });
  });
  it('projects status without repair or credential/mutation capabilities', async () => {
    const f = await makeCliFixture(); expect(await runCli(['status', '--json'], f.deps)).toBe(0);
    expect(f.calls).toEqual(['status']); expect(f.requests).toEqual([]);
    expect(output(f.lines)).toEqual({ schemaVersion: 1, mode: 'LAB_ONLY', businessReadiness: 'UNAVAILABLE',
      core: { state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: 'core-1', releaseDigest: 'a'.repeat(64), ageMs: 1000 },
      tunnel: { state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: null, releaseDigest: null, ageMs: null } });
  });
  it.each(['apply', 'start', 'stop', 'restart', 'reset-failure', 'uninstall', 'rollback'])(
    'routes %s to exactly one local port with normalized expected-state inputs', async action => {
      const f = await makeCliFixture(); const token = f.previewResult.configDigest;
      expect(await runCli(mutationArgs(action, token), f.deps)).toBe(0);
      expect(f.calls).toEqual([action]);
      expect(f.requests).toEqual([{ config: 'service', expectedPreviewDigest: token, expectedInstallDigest: null,
        ...(action === 'rollback' ? { targetReleaseDigest: 'b'.repeat(64) } : {}) }]);
      expect(output(f.lines)).toEqual({ schemaVersion: 1, mode: 'LAB_ONLY', action,
        businessReadiness: 'UNAVAILABLE', result: { ok: true, code: 'OK' } });
    });
  it('allows reordered options and preserves an explicit installation digest', async () => {
    const f = await makeCliFixture(); const token = f.previewResult.configDigest;
    expect(await runCli(['stop', '--json', '--expected-install-digest', 'c'.repeat(64),
      '--expected-config-digest', token, '--config', 'service'], f.deps)).toBe(0);
    expect(f.requests).toEqual([{ config: 'service', expectedPreviewDigest: token, expectedInstallDigest: 'c'.repeat(64) }]);
  });
  it('round-trips the real preflight preview token and preserves wrong-token refusal', async () => {
    const f = await makeCliFixture(); expect(await runCli([], f.deps)).toBe(0);
    const parsed = JSON.parse(f.lines[0] ?? '') as { preview: Preview };
    const token = parsed.preview.configDigest;
    expect(token).not.toBe(configDigest(f.config)); expect(token).not.toBe(f.config.releaseDigest);
    f.lines.length = 0; f.calls.length = 0;
    expect(await runCli(mutationArgs('apply', token), f.deps)).toBe(0);
    expect(f.calls).toEqual(['apply']);
    for (const wrong of [configDigest(f.config), f.config.releaseDigest]) {
      f.lines.length = 0;
      expect(await runCli(mutationArgs('apply', wrong), f.deps)).toBe(2);
      expect(output(f.lines)).toEqual(failure('apply', 'CONFIG_CHANGED'));
    }
  });
  it.each([
    ['preview'], ['status'], ['preview', '--json', '--json'], ['status', '--json', 'secret'],
    ['unknown', '--json'], ['--json'], ['status', '--role', 'core', '--json'],
    ['apply', '--json'], ['status', '--url', 'https://secret.invalid', '--json'],
  ].map(args => ({ args })))('refuses invalid grammar before calling any port (%j)', async ({ args }) => {
    const f = await makeCliFixture(); expect(await runCli(args, f.deps)).toBe(64);
    expect(f.calls).toEqual([]); expect(output(f.lines)).toEqual(failure(null, 'INVALID_USAGE'));
  });
  it.each([
    ['--config', '/private/service.json'], ['--config', 'SERVICE'],
    ['--expected-config-digest', 'A'.repeat(64)], ['--expected-config-digest', 'none'],
    ['--expected-install-digest', 'NONE'], ['--expected-install-digest', 'a'.repeat(63)],
  ])('refuses invalid %s value without side effects', async (flag, value) => {
    const f = await makeCliFixture(); const args = mutationArgs('apply', f.previewResult.configDigest);
    args[args.indexOf(flag) + 1] = value;
    expect(await runCli(args, f.deps)).toBe(64); expect(f.calls).toEqual([]);
    expect(output(f.lines)).toEqual(failure(null, 'INVALID_USAGE'));
  });
  it.each(['--config', '--expected-config-digest', '--expected-install-digest', '--json'])(
    'rejects duplicate or missing %s before dispatch', async flag => {
      for (const mode of ['duplicate', 'missing']) {
        const f = await makeCliFixture(); const args = mutationArgs('apply', f.previewResult.configDigest);
        const index = args.indexOf(flag); const count = flag === '--json' ? 1 : 2;
        if (mode === 'missing') args.splice(index, count); else args.push(...args.slice(index, index + count));
        expect(await runCli(args, f.deps)).toBe(64); expect(f.calls).toEqual([]);
      }
    });
  it('requires rollback target only on rollback and rejects malformed targets', async () => {
    for (const args of [mutationArgs('rollback', 'a'.repeat(64)).slice(0, -2),
      [...mutationArgs('apply', 'a'.repeat(64)), '--target-release-digest', 'b'.repeat(64)],
      [...mutationArgs('rollback', 'a'.repeat(64)).slice(0, -1), 'B'.repeat(64)]]) {
      const f = await makeCliFixture(); expect(await runCli(args, f.deps)).toBe(64); expect(f.calls).toEqual([]);
    }
  });
  it.each(['--role', '--label', '--port', '--url', '--command', '--secret', '--config=service'])(
    'rejects unknown mutation flag %s', async flag => {
      const f = await makeCliFixture();
      expect(await runCli([...mutationArgs('start', f.previewResult.configDigest), flag, 'private-value'], f.deps)).toBe(64);
      expect(f.calls).toEqual([]); expect(f.lines.join('')).not.toContain('private-value');
    });
  it('rejects oversize, sparse and accessor-bearing argv without reading accessors', async () => {
    const f = await makeCliFixture();
    expect(await runCli(['preview', 'x'.repeat(4097)], f.deps)).toBe(64); f.lines.length = 0;
    expect(await runCli(Array<string>(33).fill('--json'), f.deps)).toBe(64); f.lines.length = 0;
    expect(await runCli(Array<string>(2), f.deps)).toBe(64); f.lines.length = 0;
    let reads = 0; const args = ['status', '--json'];
    Object.defineProperty(args, '1', { enumerable: true, get() { reads++; return '--json'; } });
    expect(await runCli(args, f.deps)).toBe(64); expect(reads).toBe(0); expect(f.calls).toEqual([]);
  });
  it('detaches argv before the awaited mutation result', async () => {
    const f = await makeCliFixture(); const args = mutationArgs('apply', f.previewResult.configDigest);
    f.deps.apply = async request => {
      await Promise.resolve(); expect(request.expectedPreviewDigest).toBe(f.previewResult.configDigest);
      expect(request.config).toBe('service'); return { ok: true, code: 'OK' };
    };
    const pending = runCli(args, f.deps); args[4] = 'c'.repeat(64); args[2] = '/private/secret';
    expect(await pending).toBe(0);
  });
  it.each(['preview', 'status', 'apply', 'rollback', 'control'] as const)('returns unavailable for absent %s capability', async port => {
    const f = await makeCliFixture(); Reflect.deleteProperty(f.deps, port);
    const action = port === 'control' ? 'start' : port;
    const args = action === 'preview' || action === 'status' ? [action, '--json'] : mutationArgs(action, f.previewResult.configDigest);
    expect(await runCli(args, f.deps)).toBe(2); expect(f.calls).toEqual([]);
    expect(output(f.lines)).toEqual(failure(action, 'CAPABILITY_UNAVAILABLE'));
  });
  it('preserves a legitimate refused preview with empty digest fields', async () => {
    const f = await makeCliFixture(); const denied: Preview = { ok: false, code: 'ACCOUNT_INVALID',
      configDigest: '', previousInstallDigest: null, releaseDigest: '', roles: [] };
    f.deps.preview = async () => denied;
    expect(await runCli([], f.deps)).toBe(2);
    expect(output(f.lines)).toEqual({ schemaVersion: 1, mode: 'LAB_ONLY', action: 'preview',
      businessReadiness: 'UNAVAILABLE', preview: denied });
  });
  it.each(['preview', 'apply'])('returns exit70 for fixed internal failure from %s', async action => {
      const f = await makeCliFixture();
      f.deps.preview = async () => ({ ok: false, code: 'INTERNAL_ERROR', configDigest: '',
        previousInstallDigest: null, releaseDigest: '', roles: [] });
      f.deps.apply = async () => ({ ok: false, code: 'INTERNAL_ERROR' });
      const args = action === 'preview' ? [] : mutationArgs(action, f.previewResult.configDigest);
      expect(await runCli(args, f.deps)).toBe(70);
      expect(f.lines.join('')).toContain('INTERNAL_ERROR');
  });
  it.each([null, { ok: 'true', code: 'OK' }, { ok: true, code: 'AUTH_BLOCKED' },
    { ok: false, code: 'OK' }, { ok: true, code: 'OK', secret: 'never-output' }])(
    'contains malformed mutation results (%j)', async value => {
      const f = await makeCliFixture(); f.deps.apply = async () => value as unknown as Result;
      expect(await runCli(mutationArgs('apply', f.previewResult.configDigest), f.deps)).toBe(value === null ? 2 : 70);
      expect(output(f.lines)).toEqual(failure('apply', value === null ? 'CAPABILITY_UNAVAILABLE' : 'INTERNAL_ERROR'));
    });
  it.each(['preview', 'status', 'apply', 'rollback', 'control'] as const)('redacts a thrown %s provider error', async port => {
    const f = await makeCliFixture(); Reflect.set(f.deps, port, async () => { throw new Error('FAKE_SECRET /private/token'); });
    const action = port === 'control' ? 'stop' : port;
    const args = action === 'preview' || action === 'status' ? [action, '--json'] : mutationArgs(action, f.previewResult.configDigest);
    expect(await runCli(args, f.deps)).toBe(70); expect(output(f.lines)).toEqual(failure(action, 'INTERNAL_ERROR'));
    expect(f.lines.join('')).not.toMatch(/FAKE_SECRET|private/);
  });
  it('rejects malformed preview without spreading extra fields or invoking getters', async () => {
    for (const change of ['extra', 'getter', 'roles', 'digest', 'code']) {
      const f = await makeCliFixture(); const value = { ...f.previewResult }; let reads = 0;
      if (change === 'extra') Reflect.set(value, 'path', '/private/token');
      if (change === 'getter') Object.defineProperty(value, 'configDigest', { enumerable: true,
        get() { reads++; throw new Error('FAKE_SECRET'); } });
      if (change === 'roles') value.roles = ['core', 'core'];
      if (change === 'digest') value.configDigest = '';
      if (change === 'code') value.code = 'AUTH_BLOCKED';
      f.deps.preview = async () => value;
      expect(await runCli([], f.deps)).toBe(70); expect(reads).toBe(0);
      expect(output(f.lines)).toEqual(failure('preview', 'INTERNAL_ERROR'));
    }
  });
  it('handles null status as unavailable and malformed clock evidence as internal failure', async () => {
    for (const value of [null, {}, { nowMs: -1, core: {}, tunnel: {} }]) {
      const f = await makeCliFixture(); f.deps.status = async () => value as unknown as DiagnosticEvidence;
      expect(await runCli(['status', '--json'], f.deps)).toBe(value === null ? 2 : 70);
      expect(output(f.lines)).toEqual(failure('status', value === null ? 'CAPABILITY_UNAVAILABLE' : 'INTERNAL_ERROR'));
    }
  });
  it('rejects accessor-bearing results without invoking the accessor', async () => {
    const f = await makeCliFixture(); let reads = 0;
    const result = { ok: true, get code() { reads++; throw new Error('FAKE_SECRET'); } };
    f.deps.apply = async () => result as Result;
    expect(await runCli(mutationArgs('apply', f.previewResult.configDigest), f.deps)).toBe(70);
    expect(reads).toBe(0); expect(output(f.lines)).toEqual(failure('apply', 'INTERNAL_ERROR'));
  });
  it('attempts output only once when the output sink fails', async () => {
    const f = await makeCliFixture(); let attempts = 0;
    f.deps.output = () => { attempts++; throw new Error('FAKE_SECRET'); };
    expect(await runCli([], f.deps)).toBe(70); expect(attempts).toBe(1);
  });
  it('leaves real fixture bytes unchanged across preview and status', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gram-cli-read-'));
    try {
      const files = ['service.json', 'install-journal.json', 'agent.sqlite', 'agent.sqlite-wal'];
      const before = files.map((name, index) => Buffer.from(`${name}:${index}:FAKE_SECRET`));
      await Promise.all(files.map((name, index) => writeFile(join(directory, name), before[index] ?? Buffer.alloc(0))));
      const f = await makeCliFixture(); expect(await runCli([], f.deps)).toBe(0); f.lines.length = 0;
      expect(await runCli(['status', '--json'], f.deps)).toBe(0);
      expect(await Promise.all(files.map(name => readFile(join(directory, name))))).toEqual(before);
      expect(f.calls).toEqual(['preview', 'status']); expect(f.requests).toEqual([]);
      expect(f.lines.join('')).not.toContain('FAKE_SECRET');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('supports read-only ports without any mutation or credential port', async () => {
    const f = await makeCliFixture(); const deps: CliDeps = { preview: f.deps.preview, output: f.deps.output } as CliDeps;
    expect(await runCli([], deps)).toBe(0); expect(f.calls).toEqual(['preview']);
  });
});
