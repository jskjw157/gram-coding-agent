import { describe, expect, it } from 'vitest';
import { probeKeys, type ProbeKey, type ReadinessSnapshot, type WorkRequest } from './contracts.js';
import { evaluateReadiness } from './readiness.js';

function snapshot(): ReadinessSnapshot {
  const probes: ReadinessSnapshot['probes'] = {};
  for (const key of probeKeys) {
    probes[key] = { state: 'READY', observedAtMs: 100_000, contextId: 'runtime-session-account-1' };
  }
  return {
    host: { kind: 'macos-arm64', compatible: true, reason: 'SUPPORTED_TARGET' },
    contextId: 'runtime-session-account-1',
    probes,
  };
}
const api: WorkRequest = { kind: 'API_READ', auth: 'SERVICE' };
const browser: WorkRequest = { kind: 'BROWSER_READ', provider: 'ASIDE' };

describe('readiness evidence', () => {
  it('allows eligible API readiness when the GUI and user vault are absent', () => {
    const s = snapshot();
    delete s.probes.GUI_SESSION;
    delete s.probes.USER_VAULT;
    expect(evaluateReadiness(s, api, 100_000).status).toBe('READY');
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('UNKNOWN');
    expect(evaluateReadiness(s, { kind: 'API_READ', auth: 'USER' }, 100_000).status)
      .toBe('UNKNOWN');
  });
  it.each(['CORE', 'ISOLATION', 'SERVICE_AUTH'] satisfies ProbeKey[])(
    'does not allow missing %s', (key) => {
      const s = snapshot();
      delete s.probes[key];
      expect(evaluateReadiness(s, api, 100_000).blockers).toContainEqual({ probe: key, reason: 'MISSING' });
    },
  );
  it('fails closed when evidence is stale, future, invalid or in another context', () => {
    for (const [observedAtMs, contextId, reason] of [
      [69_999, 'runtime-session-account-1', 'STALE'],
      [100_001, 'runtime-session-account-1', 'FUTURE'],
      [Number.NaN, 'runtime-session-account-1', 'INVALID_TIME'],
      [100_000, 'previous-boot', 'CONTEXT_CHANGED'],
    ] as const) {
      const s = snapshot();
      s.probes.CORE = { state: 'READY', observedAtMs, contextId };
      expect(evaluateReadiness(s, api, 100_000).status).toBe('UNKNOWN');
      expect(evaluateReadiness(s, api, 100_000).blockers).toContainEqual({ probe: 'CORE', reason });
    }
    const s = snapshot();
    s.probes.CORE = { state: 'READY', observedAtMs: 70_000, contextId: s.contextId };
    expect(evaluateReadiness(s, api, 100_000).status).toBe('READY');
  });
  it('separates an unavailable capability from unknown evidence', () => {
    const s = snapshot();
    s.probes.GUI_SESSION = { state: 'BLOCKED', observedAtMs: 100_000, contextId: s.contextId };
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('BLOCKED');
    s.probes.GUI_SESSION.state = 'UNKNOWN';
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('UNKNOWN');
  });
  it('never substitutes Aside account evidence for Playwright', () => {
    const s = snapshot();
    delete s.probes.PLAYWRIGHT_ACCOUNT;
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('READY');
    expect(evaluateReadiness(s, { kind: 'BROWSER_READ', provider: 'PLAYWRIGHT' }, 100_000).blockers)
      .toContainEqual({ probe: 'PLAYWRIGHT_ACCOUNT', reason: 'MISSING' });
  });
  it('does not require user-vault access for an already-authenticated browser read', () => {
    const s = snapshot();
    delete s.probes.USER_VAULT;
    expect(evaluateReadiness(s, browser, 100_000).status).toBe('READY');
  });
  it('requires screen permission for capture without demanding unrelated permissions', () => {
    const s = snapshot();
    delete s.probes.SCREEN_RECORDING;
    expect(evaluateReadiness(s, { kind: 'SCREEN_CAPTURE' }, 100_000).blockers)
      .toContainEqual({ probe: 'SCREEN_RECORDING', reason: 'MISSING' });
    expect(evaluateReadiness(s, api, 100_000).status).toBe('READY');
  });
  it('rejects inconsistent host data and invalid request/time/context', () => {
    const s = snapshot();
    s.host = { kind: 'unsupported', compatible: true, reason: 'SUPPORTED_TARGET' };
    expect(evaluateReadiness(s, api, 100_000).status).toBe('UNSUPPORTED');
    expect(evaluateReadiness(snapshot(), { kind: 'SEND_PAYMENT' } as unknown as WorkRequest, 100_000).status)
      .toBe('BLOCKED');
    expect(evaluateReadiness(snapshot(), api, Number.NaN).status).toBe('UNKNOWN');
    const empty = snapshot();
    empty.contextId = '';
    expect(evaluateReadiness(empty, api, 100_000).status).toBe('UNKNOWN');
  });
  it('treats invalid probe states and mismatched request fields as unavailable', () => {
    const s = snapshot();
    s.probes.CORE = {
      state: 'UNRECOGNIZED' as 'UNKNOWN', observedAtMs: 100_000, contextId: s.contextId,
    };
    expect(evaluateReadiness(s, api, 100_000).status).toBe('UNKNOWN');
    for (const request of [
      { kind: 'API_READ', auth: 'UNRECOGNIZED' },
      { kind: 'BROWSER_READ', provider: 'UNRECOGNIZED' },
    ]) {
      expect(evaluateReadiness(snapshot(), request as unknown as WorkRequest, 100_000).status).toBe('BLOCKED');
    }
  });
  it('does not mutate the input or expose unexpected fields in its result', () => {
    const s = snapshot();
    const before = structuredClone(s);
    Object.assign(s, { password: 'FAKE_SENTINEL_DO_NOT_RETURN' });
    const result = evaluateReadiness(s, api, 100_000);
    expect(result).toEqual({ status: 'READY', blockers: [] });
    expect(JSON.stringify(result)).not.toContain('FAKE_SENTINEL');
    expect(s.probes).toEqual(before.probes);
  });
});
