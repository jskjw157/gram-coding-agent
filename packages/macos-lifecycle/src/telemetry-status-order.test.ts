import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { TelemetryStore, type RecordFiles } from './telemetry-store.js';
const owner = { role: 'core' as const, generation: 'gen-1', releaseDigest: 'a'.repeat(64) };
it('accepts sequential state transitions in the same millisecond without weakening CAS', async () => {
  let bytes: Buffer | null = null;
  const files: RecordFiles = {
    async read() { return [bytes === null ? null : Buffer.from(bytes)]; },
    async compareAndSwap(_role, expected, _slot, input) {
      const digest = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
      if (expected.length !== 1 || expected[0] !== digest) throw new Error('STATE_CONFLICT');
      bytes = Buffer.from(input);
    },
  };
  const events: RecordFiles = { async read() { return [null, null, null]; }, async compareAndSwap() { throw new Error('UNUSED'); } };
  const store = new TelemetryStore(files, events);
  const base = { schemaVersion: 1, ...owner, code: 'OK', observedAtMs: 1000, attemptCount: 0 };
  await store.writeStatus('core', { ...base, state: 'VALIDATING' }, owner);
  await store.writeStatus('core', { ...base, state: 'STARTING' }, owner);
  expect((await store.readStatus('core', owner, 1001))?.state).toBe('STARTING');
  const results = await Promise.allSettled([
    store.writeStatus('core', { ...base, state: 'RUNNING' }, owner),
    store.writeStatus('core', { ...base, state: 'STOPPING' }, owner),
  ]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
});
