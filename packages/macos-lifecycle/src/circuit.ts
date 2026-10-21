/** Pure accounting only. INVALID_HISTORY is a hard stop, never a fresh start.
 * Persist every transition before acting; no filesystem, process or auth here.
 */
export interface CircuitHistory {
  schemaVersion: 1;
  blocked: boolean;
  lastSeenMs: number;
  exitsMs: number[];
  lastGeneration: string | null;
  activeAttempt: null | { generation: string; startedAtMs: number };
}
const WINDOW_MS = 300000;
const LIMIT = 5;
function invalid(): never { throw new Error('INVALID_HISTORY'); }
function time(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}
function generation(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 128
    && /^[A-Za-z0-9]/u.test(v) && !/[^A-Za-z0-9._-]/u.test(v);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(k => typeof k !== 'string' || !keys.includes(k))) invalid();
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !d.enumerable || !('value' in d)) invalid();
    data[key] = d.value;
  }
  return data;
}
function times(value: unknown): number[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > LIMIT || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const result: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d || !d.enumerable || !('value' in d) || !time(d.value)) invalid();
    const previous = result.at(-1);
    if (previous !== undefined && d.value < previous) invalid();
    result.push(d.value);
  }
  return result;
}
export function parseHistory(value: unknown): CircuitHistory {
  try {
    const h = record(value, ['schemaVersion', 'blocked', 'lastSeenMs', 'exitsMs', 'lastGeneration', 'activeAttempt']);
    if (h.schemaVersion !== 1 || typeof h.blocked !== 'boolean' || !time(h.lastSeenMs)
      || !(h.lastGeneration === null || generation(h.lastGeneration))) invalid();
    const exitsMs = times(h.exitsMs);
    const lastSeenMs = h.lastSeenMs;
    if (exitsMs.some(t => t > lastSeenMs)) invalid();
    if (!h.blocked && exitsMs.filter(t => lastSeenMs - t < WINDOW_MS).length >= LIMIT) invalid();
    let activeAttempt: CircuitHistory['activeAttempt'] = null;
    if (h.activeAttempt !== null) {
      const a = record(h.activeAttempt, ['generation', 'startedAtMs']);
      if (h.blocked || !generation(a.generation) || a.generation !== h.lastGeneration
        || !time(a.startedAtMs) || a.startedAtMs > lastSeenMs) invalid();
      const startedAtMs = a.startedAtMs;
      if (exitsMs.some(t => t > startedAtMs)) invalid();
      activeAttempt = { generation: a.generation, startedAtMs };
    }
    return { schemaVersion: 1, blocked: h.blocked, lastSeenMs,
      exitsMs, lastGeneration: h.lastGeneration, activeAttempt };
  } catch { return invalid(); }
}
function at(history: CircuitHistory, nowMs: number): CircuitHistory {
  const h = parseHistory(history);
  if (!time(nowMs) || nowMs < h.lastSeenMs) invalid();
  return h;
}
export function freshHistory(nowMs: number): CircuitHistory {
  if (!time(nowMs)) invalid();
  return { schemaVersion: 1, blocked: false, lastSeenMs: nowMs,
    exitsMs: [], lastGeneration: null, activeAttempt: null };
}
export function recordExit(history: CircuitHistory, nowMs: number, intentional: boolean): CircuitHistory {
  const h = at(history, nowMs);
  if (typeof intentional !== 'boolean') invalid();
  const recent = h.exitsMs.filter(t => nowMs - t < WINDOW_MS);
  if (!intentional) recent.push(nowMs);
  return { ...h, lastSeenMs: nowMs, activeAttempt: null,
    exitsMs: recent.slice(-LIMIT), blocked: h.blocked || recent.length >= LIMIT };
}
export function beginAttempt(history: CircuitHistory, nextGeneration: string, nowMs: number): CircuitHistory {
  const h = at(history, nowMs);
  if (h.blocked) throw new Error('RESTART_BUDGET');
  if (h.activeAttempt !== null) throw new Error('ACTIVE_ATTEMPT');
  if (!generation(nextGeneration) || nextGeneration === h.lastGeneration) invalid();
  return { ...h, lastSeenMs: nowMs, lastGeneration: nextGeneration,
    exitsMs: h.exitsMs.filter(t => nowMs - t < WINDOW_MS),
    activeAttempt: { generation: nextGeneration, startedAtMs: nowMs } };
}
export function recoverAttempt(history: CircuitHistory, nowMs: number): CircuitHistory {
  const h = at(history, nowMs);
  return recordExit(h, nowMs, h.activeAttempt === null);
}
/** A pure reset proposal, NOT permission. Task6 must verify actual local
 * authorization and stopped state first. The next start needs a new generation.
 */
export function resetFailure(history: CircuitHistory, expectedGeneration: string, nowMs: number): CircuitHistory {
  const h = at(history, nowMs);
  if (h.activeAttempt !== null) throw new Error('ACTIVE_ATTEMPT');
  if (!generation(expectedGeneration) || expectedGeneration !== h.lastGeneration) invalid();
  return { ...h, lastSeenMs: nowMs, exitsMs: [], blocked: false };
}
