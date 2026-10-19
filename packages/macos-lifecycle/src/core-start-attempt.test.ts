import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoreStartAttempt } from './core-start-attempt.js';
import type { PeerVerdict } from './adapters/owned-process.js';
function fixture(hang?: 'load' | 'job' | 'native') {
  let state: { state: 'present'; pid: number } | { state: 'absent' } | null = { state: 'present', pid: 4242 };
  let verdict: PeerVerdict = 'OWNED';
  const calls: unknown[] = [];
  const never = () => new Promise<never>(() => {});
  const proof = createCoreStartAttempt(async () =>
    hang === 'load'
      ? never()
      : {
          uid: 550,
          executable: { dev: 3n, ino: 4n },
          nodeDigest: 'a'.repeat(64),
          helperDigest: 'a'.repeat(64),
          files: { hash: async () => 'a'.repeat(64) },
          job: async () => (hang === 'job' ? never() : state),
          peer: {
            capture: async (request) => {
              if (hang === 'native') return never();
              calls.push(request);
              return { sec: '100', usec: '2' };
            },
            current: async (request) => {
              calls.push(request);
              return verdict;
            },
          },
        },
  );
  return {
    proof,
    calls,
    setState: (value: typeof state) => {
      state = value;
    },
    setVerdict: (value: PeerVerdict) => {
      verdict = value;
    },
  };
}
describe('fixed Core supervisor start-attempt evidence', () => {
  it('binds the exact job PID to native UID, start-time and executable evidence', async () => {
    const f = fixture();
    const pin = await f.proof.capture();
    expect(pin).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.proof.current(pin ?? '', 'OWNED')).toBe(true);
    f.setState({ state: 'absent' });
    f.setVerdict('FOREIGN');
    expect(await f.proof.current(pin ?? '', 'FOREIGN')).toBe(true);
    expect(f.calls[0]).toEqual({ pid: 4242, uid: 550, executable: { dev: 3n, ino: 4n } });
  });
  it('refuses an unknown job observation or native identity', async () => {
    const f = fixture();
    f.setState(null);
    expect(await f.proof.capture()).toBeNull();
    f.setState({ state: 'present', pid: 4242 });
    f.setVerdict('UNKNOWN');
    expect(await f.proof.capture()).toBeNull();
  });
  it('does not authorize stopping a different PID now associated with the label', async () => {
    const f = fixture();
    const pin = await f.proof.capture();
    f.setState({ state: 'present', pid: 4243 });
    expect(await f.proof.current(pin ?? '', 'OWNED')).toBe(false);
  });
  it.each(['OWNED', 'UNKNOWN'] as const)(
    'does not treat absent label plus %s as proof of stopped supervisor',
    async (value) => {
      const f = fixture();
      const pin = await f.proof.capture();
      f.setState({ state: 'absent' });
      f.setVerdict(value);
      expect(await f.proof.current(pin ?? '', 'FOREIGN')).toBe(false);
    },
  );
});

afterEach(() => vi.useRealTimers());
it.each(['load', 'job', 'native'] as const)('bounds a never-settling supervisor %s observation', async (hang) => {
  vi.useFakeTimers();
  const f = fixture(hang);
  let settled = false;
  const result = f.proof.capture().then((value) => {
    settled = true;
    return value;
  });
  await vi.advanceTimersByTimeAsync(60001);
  expect(settled).toBe(true);
  expect(await result).toBeNull();
  expect(await f.proof.current('a'.repeat(64), 'OWNED')).toBe(false);
});
