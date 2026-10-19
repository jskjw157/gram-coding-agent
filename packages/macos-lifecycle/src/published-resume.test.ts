import { describe, expect, it } from 'vitest';
import { resumeFreshPublished, type FreshPublishedResumePorts } from './published-resume.js';
const digest = 'a'.repeat(64);
const pin = 'b'.repeat(64);
function fixture(
  options: {
    denied?: boolean;
    busy?: boolean;
    changed?: boolean;
    fail?: string;
    releaseError?: boolean;
    compensationError?: boolean;
  } = {},
) {
  const calls: string[] = [];
  let journal = 'PUBLISHED';
  let running = false;
  const ports: FreshPublishedResumePorts = {
    async authorizeLocalAdmin() {
      calls.push('authorize');
      return !options.denied;
    },
    async lock() {
      calls.push('lock');
      return {
        acquired: !options.busy,
        async release() {
          calls.push('release');
          if (options.releaseError) throw new Error('PRIVATE');
        },
      };
    },
    async review() {
      calls.push('review');
      return { transactionDigest: options.changed ? 'c'.repeat(64) : digest };
    },
    async startCore() {
      calls.push('start');
      running = true;
      return { ok: options.fail !== 'start', code: options.fail === 'start' ? 'PARTIAL_INSTALL' : 'OK' };
    },
    async ownedCore() {
      calls.push('owned');
      return options.fail === 'health' ? null : pin;
    },
    async markStarted(token) {
      calls.push('STARTED');
      expect(token).toBe(digest);
      if (options.fail === 'mark') return 'refused';
      journal = 'STARTED';
      return options.fail === 'mark-uncertain' ? 'uncertain' : 'confirmed';
    },
    async parkCore(value) {
      calls.push('park');
      expect(value).toBe(pin);
      running = false;
      return options.fail !== 'park';
    },
    async commit(token, value) {
      calls.push('COMMITTED');
      expect([token, value]).toEqual([digest, pin]);
      if (options.fail === 'commit') return 'refused';
      journal = 'COMMITTED';
      return options.fail === 'commit-uncertain' ? 'uncertain' : 'confirmed';
    },
    async compensateCore() {
      calls.push('compensate');
      if (options.compensationError) return false;
      running = false;
      return true;
    },
  };
  return { ports, calls, journal: () => journal, running: () => running };
}
describe('explicit fresh PUBLISHED resume', () => {
  it('requires owned health and exact stopped proof before committing, then releases the lock', async () => {
    const f = fixture();
    expect(await resumeFreshPublished(digest, f.ports)).toEqual({ ok: true, code: 'OK', stage: 'COMMITTED' });
    expect(f.calls).toEqual([
      'authorize',
      'lock',
      'review',
      'start',
      'owned',
      'STARTED',
      'park',
      'COMMITTED',
      'release',
    ]);
    expect(f.journal()).toBe('COMMITTED');
    expect(f.running()).toBe(false);
  });
  it.each(['start', 'health', 'mark', 'park', 'commit'])(
    'preserves the last journal and compensates only Core on %s refusal',
    async (fail) => {
      const f = fixture({ fail });
      const result = await resumeFreshPublished(digest, f.ports);
      expect(result.ok).toBe(false);
      expect(f.running()).toBe(false);
      expect(f.journal()).toBe(['park', 'commit'].includes(fail) ? 'STARTED' : 'PUBLISHED');
      expect(f.calls.at(-1)).toBe('release');
      expect(f.calls).toContain('compensate');
      if (fail !== 'commit') expect(f.calls).not.toContain('COMMITTED');
    },
  );
  it.each([{ denied: true }, { busy: true }, { changed: true }])(
    'refuses without services or writes: %j',
    async (options) => {
      const f = fixture(options);
      expect((await resumeFreshPublished(digest, f.ports)).ok).toBe(false);
      expect(
        f.calls.some((value) => ['start', 'owned', 'STARTED', 'park', 'COMMITTED', 'compensate'].includes(value)),
      ).toBe(false);
      expect(f.journal()).toBe('PUBLISHED');
    },
  );
  it('rejects malformed review tokens before authorization', async () => {
    const f = fixture();
    expect((await resumeFreshPublished('../untrusted', f.ports)).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });
  it('does not claim success when lock release is uncertain after commit', async () => {
    const f = fixture({ releaseError: true });
    expect(await resumeFreshPublished(digest, f.ports)).toEqual({
      ok: false,
      code: 'PARTIAL_INSTALL',
      stage: 'COMMITTED',
      lockUnknown: true,
    });
  });
  it.each(['health', 'mark-uncertain'])('preserves cleanup uncertainty after %s failure', async (fail) => {
    const f = fixture({ fail, releaseError: true });
    const result = await resumeFreshPublished(digest, f.ports);
    expect(result).toEqual({
      ok: false,
      code: 'PARTIAL_INSTALL',
      lockUnknown: true,
      ...(fail === 'health' ? { stage: 'PUBLISHED' } : { uncertain: true }),
    });
  });
  it.each(['mark-uncertain', 'commit-uncertain'])('does not report an old journal stage after %s', async (fail) => {
    const f = fixture({ fail });
    const result = await resumeFreshPublished(digest, f.ports);
    expect(result).toEqual({ ok: false, code: 'PARTIAL_INSTALL', uncertain: true });
    expect(f.journal()).toBe(fail === 'mark-uncertain' ? 'STARTED' : 'COMMITTED');
    expect(f.calls).toContain('compensate');
    expect(f.calls.at(-1)).toBe('release');
  });
  it('reports an unknown compensation outcome instead of claiming the service is stopped', async () => {
    const f = fixture({ fail: 'health', compensationError: true });
    expect(await resumeFreshPublished(digest, f.ports)).toEqual({
      ok: false,
      code: 'PARTIAL_INSTALL',
      stage: 'PUBLISHED',
      compensationUnknown: true,
    });
    expect(f.running()).toBe(true);
  });
});
