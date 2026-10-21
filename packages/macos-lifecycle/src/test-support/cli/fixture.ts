import { preview } from '../../preflight.js';
import { labConfig, makeInspector } from '../fixtures.js';
import type { CliDeps, DiagnosticEvidence } from '../../cli-contracts.js';

export function currentEvidence(): DiagnosticEvidence {
  return { nowMs: 10000,
    core: { status: { schemaVersion: 1, role: 'core', generation: 'core-1', releaseDigest: 'a'.repeat(64),
      code: 'OK', observedAtMs: 9000, attemptCount: 0, state: 'LOCAL_CORE_HEALTHY' },
    currentIdentity: { role: 'core', generation: 'core-1', releaseDigest: 'a'.repeat(64) } },
    tunnel: { status: null, currentIdentity: null } };
}
export async function makeCliFixture() {
  const config = labConfig(); const inspector = makeInspector();
  const previewResult = await preview(config, config.releaseDigest, inspector);
  const calls: string[] = []; const requests: unknown[] = []; const lines: string[] = [];
  const deps: CliDeps = {
    async preview() { calls.push('preview'); return previewResult; },
    async status() { calls.push('status'); return currentEvidence(); },
    async apply(request) {
      calls.push('apply'); requests.push(request);
      return request.expectedPreviewDigest === previewResult.configDigest
        && request.expectedInstallDigest === previewResult.previousInstallDigest
        ? { ok: true, code: 'OK' } : { ok: false, code: 'CONFIG_CHANGED' };
    },
    async rollback(request) { calls.push('rollback'); requests.push(request); return { ok: true, code: 'OK' }; },
    async control(action, request) { calls.push(action); requests.push(request); return { ok: true, code: 'OK' }; },
    output(line) { lines.push(line); },
  };
  return { config, inspector, previewResult, calls, requests, lines, deps };
}
export function mutationArgs(action: string, token: string): string[] {
  const args = [action, '--config', 'service', '--expected-config-digest', token,
    '--expected-install-digest', 'none', '--json'];
  return action === 'rollback' ? [...args, '--target-release-digest', 'b'.repeat(64)] : args;
}
