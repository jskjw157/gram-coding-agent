/**
 * AuthSessionKeeper fixture-level tests (MAC-04 WP-16, D2/D4/D11).
 *
 * No real OAuth, no network, no browser profiles. The refresh transport and
 * the reconcile hook are synthetic fixtures injected by each test.
 *
 * RED expectations: this suite FAILS until src/session-keeper.ts exists and
 * implements the contract below.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AuthSessionKeeper,
  type ChallengeKind,
  type RefreshTransport,
  type ReconcileHook,
  type SessionKey,
} from './session-keeper.js';

const KEY: SessionKey = { provider: 'p', account: 'a' };

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const keeperWith = (opts: {
  refresh: RefreshTransport;
  reconcile?: ReconcileHook;
  now?: () => number;
}) => {
  let nowValue = 1_000_000;
  const clock = opts.now ?? (() => nowValue);
  const advance = (ms: number) => {
    nowValue += ms;
  };
  const reconcile = opts.reconcile ?? (async () => undefined);
  const keeper = new AuthSessionKeeper({
    refresh: opts.refresh,
    reconcile,
    clock,
  });
  return { keeper, advance };
};

describe('expiry uses expires_in from the response, never a hardcoded TTL', () => {
  it('applies a short expires_in and reports EXPIRED after it lapses', async () => {
    const refresh = vi.fn(async () => ({ expiresInSeconds: 60 }));
    const { keeper, advance } = keeperWith({ refresh });
    keeper.seedExpired(KEY);

    await keeper.refreshNow(KEY);
    expect(keeper.snapshot(KEY).status).toBe('AUTHENTICATED');

    advance(59_000);
    expect(keeper.snapshot(KEY).status).toBe('AUTHENTICATED');
    advance(2_000);
    expect(keeper.snapshot(KEY).status).toBe('EXPIRED');
  });

  it('applies a long expires_in distinctly (pins: 1h access / 90d refresh windows)', async () => {
    const shortRefresh = vi.fn(async () => ({ expiresInSeconds: 3_600 }));
    const first = keeperWith({ refresh: shortRefresh });
    first.keeper.seedExpired(KEY);
    await first.keeper.refreshNow(KEY);
    first.advance(3_601_000);
    expect(first.keeper.snapshot(KEY).status).toBe('EXPIRED');

    const longRefresh = vi.fn(async () => ({ expiresInSeconds: 7_776_000 }));
    const second = keeperWith({ refresh: longRefresh });
    second.keeper.seedExpired(KEY);
    await second.keeper.refreshNow(KEY);
    second.advance(3_601_000);
    // A hardcoded 1h TTL would already be EXPIRED here; the 90d grant must hold.
    expect(second.keeper.snapshot(KEY).status).toBe('AUTHENTICATED');
  });
});

describe('single-flight refresh per (provider, account)', () => {
  it('serializes concurrent refreshes into one transport call', async () => {
    const gate = deferred<{ expiresInSeconds: number }>();
    const refresh = vi.fn(() => gate.promise);
    const { keeper } = keeperWith({ refresh });
    keeper.seedExpired(KEY);

    const attempts = Array.from({ length: 10 }, () => keeper.refreshNow(KEY));
    await Promise.resolve();
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);

    gate.resolve({ expiresInSeconds: 3_600 });
    const results = await Promise.all(attempts);
    expect(refresh).toHaveBeenCalledTimes(1);
    for (const snapshot of results) {
      expect(snapshot.status).toBe('AUTHENTICATED');
    }
    expect(keeper.snapshot(KEY).status).toBe('AUTHENTICATED');
  });

  it('keeps single-flight scoped per key, not global', async () => {
    const refresh = vi.fn(async (key: SessionKey) => ({
      expiresInSeconds: key.account === 'a' ? 100 : 200,
    }));
    const { keeper, advance } = keeperWith({ refresh });
    const keyB: SessionKey = { provider: 'p', account: 'b' };
    keeper.seedExpired(KEY);
    keeper.seedExpired(keyB);

    await Promise.all([keeper.refreshNow(KEY), keeper.refreshNow(keyB)]);
    expect(refresh).toHaveBeenCalledTimes(2);
    advance(150_000);
    // Distinct expires_in per key proves per-key atomic store, not a shared slot.
    expect(keeper.snapshot(KEY).status).toBe('EXPIRED');
    expect(keeper.snapshot(keyB).status).toBe('AUTHENTICATED');
  });
});

describe('rotation-crash recovery', () => {
  it('discards a refresh that was in-flight at crash: EXPIRED + reconcile, never half-new', async () => {
    const gate = deferred<{ expiresInSeconds: number }>();
    const refresh = vi.fn(() => gate.promise);
    const reconcile = vi.fn(async () => undefined);
    const { keeper } = keeperWith({ refresh, reconcile });
    keeper.seedExpired(KEY);

    const attempt = keeper.refreshNow(KEY);
    keeper.crashDuringRefresh(KEY);
    gate.resolve({ expiresInSeconds: 3_600 });
    await attempt;

    // The late-arriving rotation must NOT authenticate the session.
    expect(keeper.snapshot(KEY).status).toBe('EXPIRED');
    expect(keeper.snapshot(KEY).needsReconcile).toBe(true);
    await expect(keeper.access(KEY)).rejects.toMatchObject({
      code: 'RECONCILE_REQUIRED',
    });

    // Full re-auth + reconcile is the only way back; the crashed grant is gone.
    keeper.resolveWithReauth(KEY);
    await expect(keeper.access(KEY)).rejects.toMatchObject({
      code: 'RECONCILE_REQUIRED',
    });
    await keeper.reconcile(KEY);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await expect(keeper.access(KEY)).resolves.toMatchObject({ ok: true });
  });
});

describe('challenge mapping to WAITING_USER', () => {
  const kinds: readonly ChallengeKind[] = [
    'MFA',
    'CAPTCHA',
    'PASSKEY',
    'NEW_DEVICE',
    'LOCK',
    'REVOCATION',
  ];

  it.each(kinds)('maps %s to an opaque waiting snapshot', (kind) => {
    const { keeper } = keeperWith({ refresh: async () => ({ expiresInSeconds: 60 }) });
    keeper.seedAuthenticated(KEY, 3_600);

    keeper.signalChallenge(KEY, kind);

    const snapshot = keeper.snapshot(KEY);
    expect(snapshot.waitingAction).toBe('WAITING_USER');
    expect(snapshot.challengeKind).toBe(kind);
    // Opaque status only: Core never sees cookie/token plaintext.
    expect(JSON.stringify(snapshot)).not.toMatch(/token|cookie|secret/i);
    expect(snapshot.status).toBe(kind === 'LOCK' || kind === 'REVOCATION' ? 'LOCKED' : 'CHALLENGE');
  });

  it('refuses access while a challenge is pending', async () => {
    const { keeper } = keeperWith({ refresh: async () => ({ expiresInSeconds: 60 }) });
    keeper.seedAuthenticated(KEY, 3_600);
    keeper.signalChallenge(KEY, 'MFA');

    await expect(keeper.access(KEY)).rejects.toMatchObject({ code: 'CHALLENGE' });
  });
});

describe('reconcile-before-resume (no blind resend)', () => {
  it('refuses resume after re-auth until the reconcile hook runs', async () => {
    const reconcile = vi.fn(async () => undefined);
    const { keeper } = keeperWith({
      refresh: async () => ({ expiresInSeconds: 3_600 }),
      reconcile,
    });
    keeper.seedExpired(KEY);

    keeper.resolveWithReauth(KEY);
    expect(keeper.snapshot(KEY).needsReconcile).toBe(true);
    // Blind resend without reconcile is refused, even though auth is fresh.
    await expect(keeper.access(KEY)).rejects.toMatchObject({
      code: 'RECONCILE_REQUIRED',
    });

    await keeper.reconcile(KEY);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(keeper.snapshot(KEY).needsReconcile).toBe(false);
    await expect(keeper.access(KEY)).resolves.toMatchObject({ ok: true });
  });

  it('does not leak token plaintext through the access receipt', async () => {
    const { keeper } = keeperWith({
      refresh: async () => ({ expiresInSeconds: 3_600 }),
    });
    keeper.seedAuthenticated(KEY, 3_600);

    const receipt = await keeper.access(KEY);
    expect(JSON.stringify(receipt)).not.toMatch(/token|cookie|secret|bearer/i);
  });
});
