import type { Role } from './contracts.js';
import { encodeEvent, parseEvent } from './telemetry.js';
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export interface SegmentSummary { sequence: number; firstAtMs: number; lastAtMs: number }
function invalid(): never { throw new Error('INVALID_TELEMETRY'); }
function header(sequence: number): Buffer { return Buffer.from(JSON.stringify({ schemaVersion: 1, sequence }) + '\n'); }

/** A fixed slot holds a canonical header and canonical allowlisted event lines.
 * Streaming line validation avoids constructing a large array of parsed events.
 */
export function decodeEventSegment(bytes: Buffer, role: Role, slot: number): SegmentSummary {
  try {
    if ((role !== 'core' && role !== 'tunnel') || !Number.isInteger(slot) || slot < 0 || slot > 2
      || !Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > LOG_MAX_BYTES) invalid();
    const end = bytes.indexOf(10); if (end < 1 || end > 128) invalid();
    const h: unknown = JSON.parse(bytes.subarray(0, end).toString('utf8'));
    if (h === null || typeof h !== 'object' || Array.isArray(h)) invalid();
    const v = h as Record<string, unknown>;
    if (Object.keys(v).length !== 2 || v.schemaVersion !== 1 || typeof v.sequence !== 'number'
      || !Number.isSafeInteger(v.sequence) || v.sequence < 0 || v.sequence % 3 !== slot
      || !header(v.sequence).equals(bytes.subarray(0, end + 1))) invalid();
    let offset = end + 1; let firstAtMs: number | null = null; let lastAtMs = 0;
    while (offset < bytes.length) {
      const next = bytes.indexOf(10, offset);
      if (next <= offset || next - offset > 1024) invalid();
      const line = bytes.subarray(offset, next + 1);
      const e = parseEvent(JSON.parse(line.toString('utf8')));
      if (e.role !== role || !encodeEvent(e).equals(line) || (firstAtMs !== null && e.observedAtMs < lastAtMs)) invalid();
      if (firstAtMs === null) firstAtMs = e.observedAtMs;
      lastAtMs = e.observedAtMs; offset = next + 1;
    }
    if (firstAtMs === null) invalid();
    return { sequence: v.sequence, firstAtMs, lastAtMs };
  } catch { return invalid(); }
}

/** The store must CAS all three digests under one role/group lock. Comparing
 * only the destination would permit a stale append to a superseded segment.
 * Rotation replaces one slot, not three renames with a crash-sensitive midpoint.
 */
export function planEventAppend(slots: readonly (Buffer | null)[], role: Role, value: unknown): { slot: number; bytes: Buffer } {
  try {
    const e = parseEvent(value); if (e.role !== role) invalid();
    if (!Array.isArray(slots) || Object.getPrototypeOf(slots) !== Array.prototype
      || slots.length !== 3 || Reflect.ownKeys(slots).length !== 4) invalid();
    const present: { slot: number; bytes: Buffer; summary: SegmentSummary }[] = [];
    for (let slot = 0; slot < 3; slot++) {
      const d = Object.getOwnPropertyDescriptor(slots, String(slot));
      if (!d || !d.enumerable || !('value' in d)) invalid();
      if (d.value !== null) {
        if (!Buffer.isBuffer(d.value)) invalid();
        present.push({ slot, bytes: d.value, summary: decodeEventSegment(d.value, role, slot) });
      }
    }
    present.sort((a, b) => a.summary.sequence - b.summary.sequence);
    const newest = present.at(-1); const line = encodeEvent(e);
    if (!newest) return { slot: 0, bytes: Buffer.concat([header(0), line]) };
    if (present.length !== Math.min(newest.summary.sequence + 1, 3)) invalid();
    let previousTime = 0;
    for (let i = 0; i < present.length; i++) {
      const item = present[i]; if (!item || item.summary.sequence !== newest.summary.sequence - present.length + 1 + i
        || item.summary.firstAtMs < previousTime) invalid();
      previousTime = item.summary.lastAtMs;
    }
    if (e.observedAtMs < newest.summary.lastAtMs) invalid();
    if (newest.bytes.length + line.length <= LOG_MAX_BYTES) {
      return { slot: newest.slot, bytes: Buffer.concat([newest.bytes, line]) };
    }
    if (newest.summary.sequence >= Number.MAX_SAFE_INTEGER) invalid();
    const next = newest.summary.sequence + 1;
    return { slot: next % 3, bytes: Buffer.concat([header(next), line]) };
  } catch { return invalid(); }
}
