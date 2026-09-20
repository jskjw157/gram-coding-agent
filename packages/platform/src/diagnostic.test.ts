import { describe, expect, it } from 'vitest';
import { makeDiagnostic, runDiagnostic } from './diagnostic.js';

const facts = { platform: 'darwin', arch: 'arm64', release: '24.0.0', nodeVersion: '24.1.0' };

describe('diagnostic CLI', () => {
  it('reports a compatible platform but unknown live operational readiness', () => {
    const report = makeDiagnostic(facts);
    expect(report.mode).toBe('DIAGNOSTIC_ONLY');
    expect(report.platform.kind).toBe('macos-arm64');
    expect(Object.values(report.capabilities).map((v) => v.status))
      .toEqual(['UNKNOWN', 'UNKNOWN', 'UNKNOWN']);
    expect(report.liveProbesCollected).toBe(false);
  });
  it('omits extra facts, paths and secrets rather than serializing input objects', () => {
    const input = { ...facts, home: '/private/FAKE_PRIVATE_PATH', password: 'FAKE_SENTINEL_DO_NOT_RETURN' };
    expect(JSON.stringify(makeDiagnostic(input))).not.toMatch(/FAKE_|password|nodeVersion|release/);
  });
  it('returns 0 for diagnostic collection, not operational readiness', () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(runDiagnostic(['--json'], {
      read: () => facts, writeOut: (v) => out.push(v), writeError: (v) => err.push(v),
    })).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).capabilities.apiRead.status).toBe('UNKNOWN');
    expect(err).toEqual([]);
  });
  it('returns 2 for an unsupported execution target and still emits parseable JSON', () => {
    const out: string[] = [];
    expect(runDiagnostic(['--json'], {
      read: () => ({ ...facts, arch: 'x64' }), writeOut: (v) => out.push(v), writeError: () => undefined,
    })).toBe(2);
    expect(JSON.parse(out[0]!).platform.compatible).toBe(false);
  });
  it('rejects unsupported arguments before any probe', () => {
    const invalidArgs = [[], ['--json', '--install'], ['--login'], ['--secrets'], ['--json', '--json']];
    for (const args of invalidArgs) {
      const out: string[] = [];
      let reads = 0;
      const code = runDiagnostic(args, {
        read: () => { reads += 1; return facts; },
        writeOut: (v) => out.push(v), writeError: () => undefined,
      });
      expect(code).toBe(64);
      expect(reads).toBe(0);
      expect(out).toEqual([]);
    }
  });
  it('emits only a fixed code for exceptions, never the raw exception message', () => {
    const err: string[] = [];
    const code = runDiagnostic(['--json'], {
      read: () => { throw new Error('FAKE_SENTINEL_DO_NOT_RETURN'); },
      writeOut: () => undefined, writeError: (v) => err.push(v),
    });
    expect(code).toBe(70);
    expect(err).toEqual(['DIAGNOSTIC_FAILED\n']);
  });
});
