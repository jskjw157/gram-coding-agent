import { describe, expect, it } from 'vitest';
import { LOG_MAX_BYTES, decodeEventSegment, planEventAppend } from './event-log.js';
import { encodeEvent } from './telemetry.js';
const event = (time = 1000) => ({ schemaVersion: 1, role: 'core', generation: 'gen-1', releaseDigest: 'a'.repeat(64),
  code: 'OK', observedAtMs: time, attemptCount: 0 });
function segment(sequence: number, full = false): Buffer {
  const header = JSON.stringify({ schemaVersion: 1, sequence }) + '\n'; const line = encodeEvent(event()).toString();
  return Buffer.from(header + line.repeat(full ? Math.floor((LOG_MAX_BYTES - Buffer.byteLength(header)) / Buffer.byteLength(line)) : 1));
}
const invalid = /^INVALID_TELEMETRY$/;
describe('bounded three-slot event logs', () => {
  it('initializes only slot zero and appends only safe canonical events', () => {
    const slots = [null, null, null]; const first = planEventAppend(slots, 'core', event());
    expect(first.slot).toBe(0); expect(first.bytes).toEqual(segment(0)); expect(slots).toEqual([null, null, null]);
    const next = planEventAppend([first.bytes, null, null], 'core', event(2000));
    expect(next.slot).toBe(0); expect(next.bytes).toEqual(Buffer.concat([first.bytes, encodeEvent(event(2000))]));
    expect(decodeEventSegment(next.bytes, 'core', 0)).toEqual({ sequence: 0, firstAtMs: 1000, lastAtMs: 2000 });
  });
  it('rotates before five MiB and retains current plus the two previous segments', () => {
    expect(LOG_MAX_BYTES).toBe(5242880);
    const a = segment(0, true); const b = segment(1, true); const c = segment(2, true);
    for (const [slots, nextSequence] of [[[a, null, null], 1], [[a, b, null], 2], [[a, b, c], 3]] as const) {
      const before = slots.map(value => value === null ? null : Buffer.from(value));
      const next = planEventAppend(slots, 'core', event(2000)); expect(next.slot).toBe(nextSequence % 3);
      expect(next.bytes.length).toBeLessThanOrEqual(LOG_MAX_BYTES);
      expect(decodeEventSegment(next.bytes, 'core', next.slot).sequence).toBe(nextSequence);
      expect(slots).toEqual(before);
    }
    const next = planEventAppend([segment(3), b, c], 'core', event(2000)); expect(next.slot).toBe(0);
  }, 15000);
  it('rejects unknown slot structure or oversized bytes rather than resetting', () => {
    for (const slots of [[], [null], [null, null, null, null], [undefined, null, null],
      [Buffer.from('SYNTHETIC_SECRET'), null, null], [Buffer.alloc(LOG_MAX_BYTES + 1), null, null]]) {
      expect(() => planEventAppend(slots as (Buffer | null)[], 'core', event())).toThrow(invalid);
    }
  });
  it('rejects missing segments, duplicate sequences, wrong slots and reversed time', () => {
    for (const slots of [[null, segment(1), null], [segment(0), null, segment(2)],
      [segment(0), segment(0), null], [segment(3), null, null]]) {
      expect(() => planEventAppend(slots, 'core', event())).toThrow(invalid);
    }
    expect(() => planEventAppend([segment(0), null, null], 'core', event(999))).toThrow(invalid);
    expect(() => planEventAppend([segment(0), null, null], 'tunnel', { ...event(), role: 'tunnel' })).toThrow(invalid);
  });
  it('rejects arbitrary payloads and noncanonical log bytes', () => {
    const good = segment(0);
    for (const bytes of [Buffer.from(good.toString().trimEnd()), Buffer.from(' ' + good.toString()),
      Buffer.from(good.toString().replace('"sequence":0', '"sequence":0,"sequence":0')),
      Buffer.from(good.toString().replace('"code":"OK"', '"code":"OK","secret":"SYNTHETIC_SECRET"'))]) {
      expect(() => decodeEventSegment(bytes, 'core', 0)).toThrow(invalid);
    }
    expect(() => planEventAppend([null, null, null], 'core', { ...event(), raw: 'SYNTHETIC_SECRET' })).toThrow(invalid);
  });
});
