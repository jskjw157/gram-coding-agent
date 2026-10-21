import { describe, expect, it } from 'vitest';
import { projectStatus } from './diagnostic.js';

const digest = 'a'.repeat(64);
const unknown = { state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: null, releaseDigest: null, ageMs: null };
function evidence() {
  return {
    nowMs: 10000,
    core: {
      status: { schemaVersion: 1, role: 'core', generation: 'core-1', releaseDigest: digest,
        code: 'OK', observedAtMs: 9000, attemptCount: 0, state: 'LOCAL_CORE_HEALTHY' },
      currentIdentity: { role: 'core', generation: 'core-1', releaseDigest: digest },
    },
    tunnel: {
      status: { schemaVersion: 1, role: 'tunnel', generation: 'tunnel-1', releaseDigest: digest,
        code: 'OK', observedAtMs: 9500, attemptCount: 0, state: 'DISABLED' },
      currentIdentity: { role: 'tunnel', generation: 'tunnel-1', releaseDigest: digest },
    },
  };
}

describe('safe lifecycle projection', () => {
  it('projects current supplied local evidence without claiming business readiness', () => {
    expect(projectStatus(evidence())).toEqual({ schemaVersion: 1, mode: 'LAB_ONLY',
      businessReadiness: 'UNAVAILABLE',
      core: { state: 'LOCAL_CORE_HEALTHY', code: 'OK', generation: 'core-1', releaseDigest: digest, ageMs: 1000 },
      tunnel: { state: 'DISABLED', code: 'OK', generation: 'tunnel-1', releaseDigest: digest, ageMs: 500 } });
  });
  it.each([null, undefined, {}, [], 'secret', { nowMs: 10 }])('reports missing evidence as unknown (%j)', input => {
    expect(projectStatus(input)).toEqual({ schemaVersion: 1, mode: 'LAB_ONLY',
      businessReadiness: 'UNAVAILABLE', core: unknown, tunnel: unknown });
  });
  it('does not promote a healthy stored record without a current verified context', () => {
    const input = evidence();
    Reflect.set(input.core, 'currentIdentity', null);
    expect(projectStatus(input).core).toEqual(unknown);
    expect(projectStatus(input).tunnel.state).toBe('DISABLED');
  });
  it.each([
    ['role', 'tunnel'], ['generation', 'replacement'], ['releaseDigest', 'b'.repeat(64)],
    ['generation', '/private/secret'], ['releaseDigest', 'A'.repeat(64)],
  ])('rejects mismatched or invalid current %s', (key, value) => {
    const input = evidence(); Reflect.set(input.core.currentIdentity, key, value);
    expect(projectStatus(input).core).toEqual(unknown);
  });
  it.each([
    ['role', 'tunnel'], ['state', 'TRANSPORT_READY'], ['state', 'SHOPPING_READY'],
    ['code', 'raw-provider-secret'], ['code', 'AUTH_BLOCKED'], ['attemptCount', 6],
    ['generation', ''], ['releaseDigest', 'short'], ['schemaVersion', 2],
  ])('rejects malformed core status %s', (key, value) => {
    const input = evidence(); Reflect.set(input.core.status, key, value);
    expect(projectStatus(input).core).toEqual(unknown);
  });
  it.each([10001, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects future or invalid observation time %s', value => {
    const input = evidence(); input.core.status.observedAtMs = value;
    expect(projectStatus(input).core).toEqual(unknown);
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid projection clock %s', value => {
    const input = evidence(); input.nowMs = value;
    expect(projectStatus(input).core).toEqual(unknown);
    expect(projectStatus(input).tunnel).toEqual(unknown);
  });
  it('accepts 29999ms but expires evidence at exactly30000ms', () => {
    const input = evidence(); input.nowMs = 38999;
    expect(projectStatus(input).core.ageMs).toBe(29999);
    input.nowMs = 39000;
    expect(projectStatus(input).core).toEqual(unknown);
  });
  it('rejects extra or missing status fields without invoking accessors', () => {
    const input = evidence(); Reflect.set(input.core.status, 'secret', 'never-output');
    expect(projectStatus(input).core).toEqual(unknown);
    Reflect.deleteProperty(input.core.status, 'secret'); Reflect.deleteProperty(input.core.status, 'code');
    expect(projectStatus(input).core).toEqual(unknown);
    let reads = 0;
    Object.defineProperty(input.core, 'status', { enumerable: true, get() { reads++; throw new Error('private'); } });
    expect(projectStatus(input).core).toEqual(unknown); expect(reads).toBe(0);
  });
  it('rejects extra fields and accessors in current identity without disclosure', () => {
    const input = evidence(); Reflect.set(input.core.currentIdentity, 'secret', 'never-output');
    expect(projectStatus(input).core).toEqual(unknown);
    Reflect.deleteProperty(input.core.currentIdentity, 'secret');
    let reads = 0;
    Object.defineProperty(input.core.currentIdentity, 'generation', { enumerable: true,
      get() { reads++; return 'core-1'; } });
    expect(projectStatus(input).core).toEqual(unknown); expect(reads).toBe(0);
  });
  it('returns detached projection after the input changes', () => {
    const input = evidence(); const result = projectStatus(input);
    input.core.status.generation = 'replacement';
    expect(result.core.generation).toBe('core-1');
    expect(JSON.stringify(result)).not.toContain('observedAtMs');
  });
  it('preserves known refusal state and code instead of inventing health', () => {
    const input = evidence(); input.core.status.state = 'AUTH_BLOCKED'; input.core.status.code = 'AUTH_BLOCKED';
    expect(projectStatus(input).core).toEqual({ state: 'AUTH_BLOCKED', code: 'AUTH_BLOCKED',
      generation: 'core-1', releaseDigest: digest, ageMs: 1000 });
  });
});
