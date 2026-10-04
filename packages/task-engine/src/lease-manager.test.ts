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
