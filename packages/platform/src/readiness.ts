import type {
  Blocker, Observation, ProbeKey, ReadinessResult, ReadinessSnapshot, WorkRequest,
} from './contracts.js';

export const MAX_PROBE_AGE_MS = 30_000;

function requirements(request: WorkRequest): ProbeKey[] | null {
  const base: ProbeKey[] = ['CORE', 'ISOLATION'];
  switch (request.kind) {
    case 'API_READ':
      if (request.auth === 'NONE') return base;
      if (request.auth === 'SERVICE') return [...base, 'SERVICE_AUTH'];
      if (request.auth === 'USER') return [...base, 'GUI_SESSION', 'USER_VAULT'];
      return null;
    case 'BROWSER_READ':
      if (request.provider === 'ASIDE') return [...base, 'GUI_SESSION', 'ASIDE', 'ASIDE_ACCOUNT'];
      if (request.provider === 'PLAYWRIGHT') return [...base, 'GUI_SESSION', 'PLAYWRIGHT', 'PLAYWRIGHT_ACCOUNT'];
      return null;
    case 'SCREEN_CAPTURE':
      return [...base, 'GUI_SESSION', 'SCREEN_RECORDING'];
    default:
      return null;
  }
}

function check(
  probe: ProbeKey, observation: Observation | undefined, contextId: string, nowMs: number,
): Blocker | null {
  const fail = (reason: Blocker['reason']): Blocker => ({ probe, reason });
  if (!observation) return fail('MISSING');
  if (observation.contextId !== contextId) return fail('CONTEXT_CHANGED');
  if (!Number.isFinite(observation.observedAtMs) || observation.observedAtMs < 0) return fail('INVALID_TIME');
  if (observation.observedAtMs > nowMs) return fail('FUTURE');
  if (nowMs - observation.observedAtMs > MAX_PROBE_AGE_MS) return fail('STALE');
  if (observation.state === 'BLOCKED') return fail('BLOCKED');
  if (observation.state !== 'READY') return fail('UNKNOWN');
  return null;
}

export function evaluateReadiness(
  snapshot: ReadinessSnapshot, request: WorkRequest, nowMs: number,
): ReadinessResult {
  if (!snapshot.host.compatible || snapshot.host.reason !== 'SUPPORTED_TARGET'
    || !['macos-arm64', 'linux-wsl'].includes(snapshot.host.kind)) {
    return { status: 'UNSUPPORTED', blockers: [{ probe: 'HOST', reason: 'UNSUPPORTED_HOST' }] };
  }
  const needed = requirements(request);
  if (needed === null) return { status: 'BLOCKED', blockers: [{ probe: 'REQUEST', reason: 'INVALID_REQUEST' }] };
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return { status: 'UNKNOWN', blockers: [{ probe: 'CLOCK', reason: 'INVALID_CLOCK' }] };
  }
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(snapshot.contextId)) {
    return { status: 'UNKNOWN', blockers: [{ probe: 'CONTEXT', reason: 'INVALID_CONTEXT' }] };
  }
  const blockers = needed.flatMap((key) => {
    const blocker = check(key, snapshot.probes[key], snapshot.contextId, nowMs);
    return blocker ? [blocker] : [];
  });
  const status = blockers.some((b) => b.reason === 'BLOCKED')
    ? 'BLOCKED' : blockers.length > 0 ? 'UNKNOWN' : 'READY';
  return { status, blockers };
}
