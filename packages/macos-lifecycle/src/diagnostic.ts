import type { Role } from './contracts.js';
import type { LifecycleReport, PublicRoleStatus } from './cli-contracts.js';
import { currentStatus, type StatusIdentity } from './telemetry.js';

function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}
function unknown(): PublicRoleStatus {
  return { state: 'UNKNOWN', code: 'HEALTH_UNKNOWN', generation: null, releaseDigest: null, ageMs: null };
}
function projectRole(value: unknown, role: Role, nowMs: number): PublicRoleStatus {
  try {
    const observation = record(value, ['status', 'currentIdentity']);
    const identity = record(observation?.currentIdentity, ['role', 'generation', 'releaseDigest']);
    if (identity?.role !== role || typeof identity.generation !== 'string' || typeof identity.releaseDigest !== 'string') return unknown();
    const context: StatusIdentity = { role, generation: identity.generation, releaseDigest: identity.releaseDigest };
    const status = currentStatus(observation?.status, context, nowMs);
    if (!status) return unknown();
    return { state: status.state, code: status.code, generation: status.generation,
      releaseDigest: status.releaseDigest, ageMs: nowMs - status.observedAtMs };
  } catch { return unknown(); }
}

/** Pure INTERNAL projection, not a native verifier or public ownership claim.
 * A's source supplies current context; stored status alone is insufficient.
 */
export function projectStatus(evidence: unknown): LifecycleReport {
  let core = unknown(); let tunnel = unknown();
  try {
    const input = record(evidence, ['nowMs', 'core', 'tunnel']);
    const nowMs = input?.nowMs;
    if (typeof nowMs === 'number' && Number.isSafeInteger(nowMs) && nowMs >= 0) {
      core = projectRole(input?.core, 'core', nowMs);
      tunnel = projectRole(input?.tunnel, 'tunnel', nowMs);
    }
  } catch { /* Untrusted provider objects never escape to public output. */ }
  return { schemaVersion: 1, mode: 'LAB_ONLY', core, tunnel, businessReadiness: 'UNAVAILABLE' };
}
