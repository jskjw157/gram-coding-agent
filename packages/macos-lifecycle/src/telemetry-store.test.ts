import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { TelemetryStore, type RecordFiles } from './telemetry-store.js';
import { decodeStatus, encodeStatus } from './telemetry.js';
import type { Role } from './contracts.js';
const event = (observedAtMs = 1000) => ({ schemaVersion: 1, role: 'core', generation: 'gen-1', releaseDigest: 'a'.repeat(64),
  code: 'OK', observedAtMs, attemptCount: 0 });
const status = (time = 1000) => ({ ...event(time), state: 'LOCAL_CORE_HEALTHY' });
const owner = () => ({ role: 'core' as const, generation: 'gen-1', releaseDigest: 'a'.repeat(64) });
function memory(size: number) {
  const data = new Map<Role, (Buffer | null)[]>([['core', Array.from({ length: size }, () => null)], ['tunnel', Array.from({ length: size }, () => null)]]);
  const get = (role: Role) => { const value = data.get(role); if (!value) throw new Error('INVALID_TELEMETRY'); return value; };
  const digest = (b: Buffer | null) => b === null ? null : createHash('sha256').update(b).digest('hex');
  let calls = 0;
  const files: RecordFiles = {
    async read(role) { return get(role).map(b => b === null ? null : Buffer.from(b)); },
    async compareAndSwap(role, expected, slot, bytes) {
      if (JSON.stringify(get(role).map(digest)) !== JSON.stringify(expected)) throw new Error('STATE_CONFLICT');
      get(role)[slot] = Buffer.from(bytes); calls++;
    },
  };
  return { data, files, calls: () => calls };
}
function fixture() { const s = memory(1); const e = memory(3); return { s, e, store: new TelemetryStore(s.files, e.files) }; }
describe('generation-aware status and safe event persistence', () => {
  it('samples the observation clock after asynchronous status reading completes', async () => {
    let now = 1000; let sampled = 0; let finish: () => void = () => { throw new Error('not ready'); };
    const ready = new Promise<void>(resolve => { finish = resolve; });
    const f = fixture();
    const delayed: RecordFiles = {
      async read() { await ready; return [encodeStatus(status(1005))]; },
      compareAndSwap: f.s.files.compareAndSwap,
    };
    const store = new TelemetryStore(delayed, f.e.files);
    const reading = store.readStatus('core', owner(), () => { sampled++; return now; });
    expect(sampled).toBe(0);
    // The supervisor publishes during trusted descriptor/ACL IO. Its timestamp
    // is newer than read-start, but is not in the future when the read completes.
    now = 1010; finish();
    expect(await reading).toEqual(decodeStatus(encodeStatus(status(1005))));
    expect(sampled).toBe(1);
    expect(f.s.calls()).toBe(0);
  });
  it.each([
    { observedAt: 1011, completedAt: 1010, generation: 'gen-1' },
    { observedAt: 1000, completedAt: 31000, generation: 'gen-1' },
    { observedAt: 1000, completedAt: 1010, generation: 'different' },
    { observedAt: 1000, completedAt: NaN, generation: 'gen-1' },
  ])('still refuses invalid completion-time evidence %#', async ({ observedAt, completedAt, generation }) => {
    const f = fixture();
    f.s.data.set('core', [encodeStatus({ ...status(observedAt), generation })]);
    expect(await f.store.readStatus('core', owner(), () => completedAt)).toBeNull();
    expect(f.s.calls()).toBe(0);
  });
  it('reads absence without creating state and persists a current observation', async () => {
    const f = fixture(); expect(await f.store.readStatus('core', owner(), 1000)).toBe(null); expect(f.s.calls()).toBe(0);
    await f.store.writeStatus('core', status(), owner());
    expect(await f.store.readStatus('core', owner(), 1001)).toEqual(decodeStatus(encodeStatus(status())));
    expect(await f.store.readStatus('core', owner(), 31000)).toBe(null);
    expect(await f.store.readStatus('core', { ...owner(), generation: 'gen-2' }, 1001)).toBe(null);
  });
  it('refuses mismatched role, owner and unknown payload fields before storage', async () => {
    const f = fixture();
    for (const input of [{ ...status(), role: 'tunnel' }, { ...status(), generation: 'gen-2' },
      { ...status(), releaseDigest: 'b'.repeat(64) }, { ...status(), message: 'SYNTHETIC_SECRET' }]) {
      await expect(f.store.writeStatus('core', input, owner())).rejects.toThrow(/^INVALID_TELEMETRY$/);
    }
    await expect(f.store.appendEvent('core', { ...event(), role: 'tunnel' })).rejects.toThrow(/^INVALID_TELEMETRY$/);
    expect(f.s.calls()).toBe(0); expect(f.e.calls()).toBe(0);
  });
  it('does not overwrite corrupt status or reverse observation time', async () => {
    const f = fixture(); await f.store.writeStatus('core', status(2000), owner());
    await expect(f.store.writeStatus('core', status(1000), owner())).rejects.toThrow(/^STATE_CONFLICT$/);
    f.s.data.set('core', [Buffer.from('{"secret":')]);
    await expect(f.store.writeStatus('core', status(3000), owner())).rejects.toThrow(/^INVALID_TELEMETRY$/);
    expect(f.s.calls()).toBe(1);
  });
  it('rejects concurrent stale status updates and keeps the winner intact', async () => {
    const f = fixture(); const result = await Promise.allSettled([
      f.store.writeStatus('core', status(1000), owner()), f.store.writeStatus('core', status(2000), owner()),
    ]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.s.calls()).toBe(1);
  });
  it('appends safe records and fences concurrent event writers against the full set', async () => {
    const f = fixture(); await f.store.appendEvent('core', event());
    const result = await Promise.allSettled([f.store.appendEvent('core', event(2000)), f.store.appendEvent('core', event(3000))]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(f.e.calls()).toBe(2);
    const slots = await f.e.files.read('core'); const first = slots[0];
    if (!first) throw new Error('MISSING_TEST_LOG'); expect(first.toString().split('\n')).toHaveLength(4);
    expect(first.toString()).not.toContain('SYNTHETIC_SECRET'); expect(await f.e.files.read('tunnel')).toEqual([null, null, null]);
  });
  it('awaits the durable writer and returns fixed errors without retries', async () => {
    const f = fixture(); let calls = 0;
    const broken: RecordFiles = { read: f.s.files.read, async compareAndSwap() { calls++; throw new Error('SYNTHETIC_SECRET'); } };
    const store = new TelemetryStore(broken, f.e.files);
    await expect(store.writeStatus('core', status(), owner())).rejects.toThrow(/^STATE_IO$/); expect(calls).toBe(1);
    expect(await store.readStatus('core', owner(), 1000)).toBe(null);
  });
  it('does not retry ambiguous commits or convert corrupted logs into fresh logs', async () => {
    const f = fixture(); let calls = 0;
    const ambiguous: RecordFiles = { read: f.e.files.read, async compareAndSwap(...args) {
      calls++; await f.e.files.compareAndSwap(...args); throw new Error('disk sync failed SYNTHETIC_SECRET');
    } };
    await expect(new TelemetryStore(f.s.files, ambiguous).appendEvent('core', event())).rejects.toThrow(/^STATE_IO$/);
    expect(calls).toBe(1); expect(f.e.calls()).toBe(1);
    f.e.data.set('core', [Buffer.from('broken'), null, null]);
    await expect(f.store.appendEvent('core', event())).rejects.toThrow(/^INVALID_TELEMETRY$/); expect(f.e.calls()).toBe(1);
  });
  it('copies caller data before asynchronous persistence', async () => {
    const f = fixture(); const value = status(); const saving = f.store.writeStatus('core', value, owner());
    value.generation = 'changed'; await saving;
    expect((await f.store.readStatus('core', owner(), 1001))?.generation).toBe('gen-1');
  });
});
