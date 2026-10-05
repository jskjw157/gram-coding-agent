import { describe, expect, it } from 'vitest';
import { LeaseManager, StaleFenceError } from './lease-manager.js';

describe('LeaseManager (durable execution core)', () => {
  it('RED: acquires multiple leases all-or-nothing in sorted order (no partial acquire)', () => {
    const lm = new LeaseManager({ now: () => 1_000 });
    lm.acquire(['res-b'], 'owner-1');
    expect(() => lm.acquire(['res-a', 'res-b'], 'owner-2')).toThrow();
    // res-a must NOT be left held as a partial side effect.
    const retry = lm.acquire(['res-a'], 'owner-2');
    expect(retry.resources).toEqual(['res-a']);
  });

  it('RED: fence_epoch is monotonic across acquires', () => {
    const lm = new LeaseManager({ now: () => 1_000 });
    const first = lm.acquire(['res-a'], 'owner-1');
    lm.release(['res-a'], 'owner-1', first.token);
    const second = lm.acquire(['res-a'], 'owner-2');
    expect(second.fenceEpoch).toBeGreaterThan(first.fenceEpoch);
  });

  it('RED: only owner+token can release', () => {
    const lm = new LeaseManager({ now: () => 1_000 });
    const lease = lm.acquire(['res-a'], 'owner-1');
    expect(() => lm.release(['res-a'], 'intruder', lease.token)).toThrow();
    expect(() => lm.release(['res-a'], 'owner-1', 'wrong-token')).toThrow();
    // Still held: nobody else can take it.
    expect(() => lm.acquire(['res-a'], 'owner-2')).toThrow();
  });

  it('RED: stale fence is rejected', () => {
    const lm = new LeaseManager({ now: () => 1_000 });
    const first = lm.acquire(['res-a'], 'owner-1');
    lm.release(['res-a'], 'owner-1', first.token);
    lm.acquire(['res-a'], 'owner-2');
    expect(lm.isStale('res-a', first.fenceEpoch)).toBe(true);
    expect(() => lm.assertUsable('res-a', first.fenceEpoch)).toThrow(StaleFenceError);
  });

  it('RED: durable block survives TTL expiry (block vs TTL separation)', () => {
    let now = 1_000;
    const lm = new LeaseManager({ now: () => now, ttlMs: 500 });
    lm.block('res-a', 'manual-hold');
    now += 10_000; // far past TTL
    expect(lm.isBlocked('res-a')).toBe(true);
    expect(() => lm.acquire(['res-a'], 'owner-1')).toThrow();
    lm.unblock('res-a');
    const lease = lm.acquire(['res-a'], 'owner-1');
    expect(lease.resources).toEqual(['res-a']);
  });

  it('RED: expired TTL lease can be re-acquired, but a live lease cannot', () => {
    let now = 1_000;
    const lm = new LeaseManager({ now: () => now, ttlMs: 500 });
    lm.acquire(['res-a'], 'owner-1');
    expect(() => lm.acquire(['res-a'], 'owner-2')).toThrow();
    now += 600; // past TTL
    const lease = lm.acquire(['res-a'], 'owner-2');
    expect(lease.owner).toBe('owner-2');
  });
});

describe('LeaseManager durable wiring T4 RED (restart + full assertUsable)', () => {
  it('RED T4a: restart loses lease hold (fresh manager re-acquires held resource)', () => {
    const lm1 = new LeaseManager({ now: () => 1_000 });
    lm1.acquire(['res-a'], 'owner-1');
    const snap = lm1.snapshot();
    // Fresh instance with no rehydrate must NOT see the hold; rehydrated must.
    const fresh = new LeaseManager({ now: () => 1_000 });
    expect(() => fresh.acquire(['res-a'], 'owner-2')).not.toThrow();
    const restored = new LeaseManager({ now: () => 1_000 });
    restored.rehydrate(snap);
    expect(() => restored.acquire(['res-a'], 'owner-2')).toThrow();
  });

  it('RED T4b: restart loses durable block', () => {
    const lm1 = new LeaseManager({ now: () => 1_000 });
    lm1.block('res-a', 'manual-hold');
    const snap = lm1.snapshot();
    const fresh = new LeaseManager({ now: () => 1_000 });
    expect(() => fresh.acquire(['res-a'], 'owner-1')).not.toThrow();
    const restored = new LeaseManager({ now: () => 1_000 });
    restored.rehydrate(snap);
    expect(restored.isBlocked('res-a')).toBe(true);
    expect(() => restored.acquire(['res-a'], 'owner-1')).toThrow();
  });

  it('RED T4c: restart resets fence epoch (fence regression)', () => {
    const lm1 = new LeaseManager({ now: () => 1_000 });
    const first = lm1.acquire(['res-a'], 'owner-1');
    lm1.release(['res-a'], 'owner-1', first.token);
    const second = lm1.acquire(['res-a'], 'owner-2');
    const snap = lm1.snapshot();
    const fresh = new LeaseManager({ now: () => 1_000 });
    const regressed = fresh.acquire(['res-a'], 'owner-3');
    expect(regressed.fenceEpoch).toBe(1); // epoch restarted: stale workers look fresh
    const restored = new LeaseManager({ now: () => 1_000 });
    restored.rehydrate(snap);
    restored.release(['res-a'], second.owner, second.token);
    const next = restored.acquire(['res-a'], 'owner-3');
    expect(next.fenceEpoch).toBeGreaterThan(second.fenceEpoch);
  });

  it('RED T4d: assertUsable-alone passes an EXPIRED lease (stale worker slips through)', () => {
    let now = 1_000;
    const lm = new LeaseManager({ now: () => now, ttlMs: 500 });
    const lease = lm.acquire(['res-a'], 'owner-1');
    now += 10_000; // far past TTL: nobody holds res-a anymore
    // Legacy 2-arg form sees a matching epoch and stays silent: insufficient.
    expect(() => lm.assertUsable('res-a', lease.fenceEpoch)).not.toThrow();
    // Full identity-carrying form must refuse the lapsed hold.
    expect(() => lm.assertUsable('res-a', lease.fenceEpoch, 'owner-1', lease.token)).toThrow();
  });

  it('RED T4e: assertUsable-alone passes a RELEASED lease (nobody holds it)', () => {
    const lm = new LeaseManager({ now: () => 1_000 });
    const lease = lm.acquire(['res-a'], 'owner-1');
    lm.release(['res-a'], 'owner-1', lease.token);
    // Legacy 2-arg form stays silent even though no lease exists: insufficient.
    expect(() => lm.assertUsable('res-a', lease.fenceEpoch)).not.toThrow();
    // Full form must refuse: there is no current lease.
    expect(() => lm.assertUsable('res-a', lease.fenceEpoch, 'owner-1', lease.token)).toThrow();
  });

  it('RED T4f: full assertUsable refuses owner/token mismatch', () => {
    const lm = new LeaseManager({ now: () => 1_000 });
    const lease = lm.acquire(['res-a'], 'owner-1');
    // Legacy form cannot see identity at all: passes for an impostor epoch-holder.
    expect(() => lm.assertUsable('res-a', lease.fenceEpoch)).not.toThrow();
    // Full form refuses the impostor but admits the true holder.
    expect(() => lm.assertUsable('res-a', lease.fenceEpoch, 'intruder', lease.token)).toThrow();
    expect(() => lm.assertUsable('res-a', lease.fenceEpoch, 'owner-1', 'wrong-token')).toThrow();
    expect(() =>
      lm.assertUsable('res-a', lease.fenceEpoch, 'owner-1', lease.token),
    ).not.toThrow();
  });

  it('RED T4g: full assertUsable checks epoch + durable block together', () => {
    const lm = new LeaseManager({ now: () => 1_000 });
    const first = lm.acquire(['res-a'], 'owner-1');
    lm.release(['res-a'], 'owner-1', first.token);
    const second = lm.acquire(['res-a'], 'owner-2');
    // Superseded holder is stale even with correct identity.
    expect(() =>
      lm.assertUsable('res-a', first.fenceEpoch, first.owner, first.token),
    ).toThrow(StaleFenceError);
    // Current holder passes until the resource is durably blocked.
    expect(() =>
      lm.assertUsable('res-a', second.fenceEpoch, second.owner, second.token),
    ).not.toThrow();
    lm.block('res-a', 'incident-hold');
    expect(() =>
      lm.assertUsable('res-a', second.fenceEpoch, second.owner, second.token),
    ).toThrow();
  });

  it('RED T4h: every mutation emits a journal event for the WP-07 persistence target', () => {
    const events: string[] = [];
    const lm = new LeaseManager({
      now: () => 1_000,
      journal: (event) => {
        events.push(event.kind);
      },
    });
    const lease = lm.acquire(['res-a'], 'owner-1');
    lm.heartbeat(lease);
    lm.release(['res-a'], 'owner-1', lease.token);
    lm.block('res-b', 'hold');
    lm.unblock('res-b');
    expect(events).toEqual(['acquired', 'heartbeat', 'released', 'blocked', 'unblocked']);
  });
});
