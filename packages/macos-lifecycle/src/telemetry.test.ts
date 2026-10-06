import { describe, expect, it } from 'vitest';
import { currentStatus, decodeStatus, encodeEvent, encodeStatus, parseEvent, parseStatus } from './telemetry.js';
const event = () => ({ schemaVersion: 1, role: 'core', generation: 'gen-1', releaseDigest: 'a'.repeat(64),
  code: 'OK', observedAtMs: 1000, attemptCount: 0 });
const status = () => ({ ...event(), state: 'LOCAL_CORE_HEALTHY' });
const identity = () => ({ role: 'core' as const, generation: 'gen-1', releaseDigest: 'a'.repeat(64) });
const invalid = /^INVALID_TELEMETRY$/;
describe('closed local lifecycle telemetry', () => {
  it('round trips detached canonical status and safe events', () => {
    const input = status(); const value = parseStatus(input); input.generation = 'changed';
    expect(value.generation).toBe('gen-1');
    expect(decodeStatus(encodeStatus(value))).toEqual(value);
    expect(encodeEvent(event()).toString()).toBe(JSON.stringify(parseEvent(event())) + '\n');
    expect(encodeStatus(status()).toString().endsWith('\n')).toBe(true);
  });
  it.each([null, [], false, 'token', 42])('rejects a non-record %s', value => {
    expect(() => parseStatus(value)).toThrow(invalid);
  });
  it.each([
    { schemaVersion: 2 }, { role: 'other' }, { generation: '' }, { generation: '../key' },
    { generation: 'x'.repeat(129) }, { releaseDigest: 'not-a-digest' }, { releaseDigest: 'A'.repeat(64) },
    { code: 'TOKEN=synthetic' }, { observedAtMs: -1 }, { observedAtMs: NaN },
    { observedAtMs: Infinity }, { observedAtMs: 1.5 }, { observedAtMs: Number.MAX_SAFE_INTEGER + 1 },
    { attemptCount: -1 }, { attemptCount: 6 }, { attemptCount: 1.2 }, { state: 'SHOP_READY' },
    { state: 'TRANSPORT_READY' }, { code: 'HEALTH_UNKNOWN' },
  ])('rejects invalid status fields %j', patch => {
    expect(() => parseStatus({ ...status(), ...patch })).toThrow(invalid);
  });
  it('never reads arbitrary fields, getters or exception messages', () => {
    let reads = 0;
    const input = Object.defineProperty(status(), 'message', { enumerable: true, get() { reads++; throw new Error('SYNTHETIC_SECRET'); } });
    expect(() => encodeStatus(input)).toThrow(invalid); expect(reads).toBe(0);
    expect(() => parseEvent({ ...event(), stdout: 'SYNTHETIC_SECRET' })).toThrow(invalid);
    expect(() => parseStatus(Object.create(status()))).toThrow(invalid);
    expect(() => parseStatus({ ...status(), [Symbol('secret')]: true })).toThrow(invalid);
    expect(() => parseStatus(Object.defineProperty(status(), 'hidden', { value: 1 }))).toThrow(invalid);
    const replaced = Object.defineProperty(status(), 'code', { enumerable: true, get() { reads++; return 'OK'; } });
    expect(() => parseStatus(replaced)).toThrow(invalid); expect(reads).toBe(0);
  });
  it('separates core and tunnel state vocabularies', () => {
    expect(parseStatus({ ...event(), role: 'tunnel', state: 'TRANSPORT_READY' }).state).toBe('TRANSPORT_READY');
    expect(() => parseStatus({ ...status(), role: 'tunnel' })).toThrow(invalid);
    expect(parseStatus({ ...event(), state: 'BLOCKED_RESTART_BUDGET', code: 'RESTART_BUDGET' }).state).toBe('BLOCKED_RESTART_BUDGET');
    expect(() => parseStatus({ ...status(), state: 'BLOCKED_RESTART_BUDGET' })).toThrow(invalid);
  });
  it('rejects malformed, duplicate-key, noncanonical and oversized persisted bytes', () => {
    const good = encodeStatus(status());
    for (const bad of [Buffer.alloc(0), Buffer.from('{'), Buffer.from('null\n'), Buffer.alloc(65537),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), good]), Buffer.from(' ' + good.toString()),
      Buffer.from(good.toString().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')),
      Buffer.from(good.toString().replace('gen-1', 'gen-\ufffd'))]) {
      expect(() => decodeStatus(bad)).toThrow(invalid);
    }
  });
  it('does not reuse status across generation, release or role', () => {
    expect(currentStatus(status(), identity(), 1001)).toEqual(parseStatus(status()));
    for (const other of [{ ...identity(), generation: 'gen-2' }, { ...identity(), releaseDigest: 'b'.repeat(64) },
      { ...identity(), role: 'tunnel' as const }]) expect(currentStatus(status(), other, 1001)).toBe(null);
  });
  it('expires at thirty seconds and refuses clock anomalies', () => {
    expect(currentStatus(status(), identity(), 30999)).not.toBe(null);
    for (const now of [31000, 31001, 999, -1, Infinity, NaN]) expect(currentStatus(status(), identity(), now)).toBe(null);
    expect(currentStatus({ secret: 'SYNTHETIC_SECRET' }, identity(), 1001)).toBe(null);
  });
});
