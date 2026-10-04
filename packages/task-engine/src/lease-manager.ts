// lease-manager.ts — durable execution core: leases + fencing (MAC-03 WP-11, D12).
//
// Leases are mutual-exclusion guards around effect dispatch. They are NOT a
// scheduler: this module never queues, orders, or runs work.
//
// Implementation choices (recorded per brief):
// - DEFAULT_TTL_MS = 30_000: a lease lapses if the holder stops heartbeating.
// - DEFAULT_HEARTBEAT_MS = 10_000: holders must renew at ~1/3 TTL.
// - fence_epoch is a process-local monotonic counter bumped on every
//   successful acquire and never decremented. A durable port would persist
//   (resource -> epoch) next to the operations/effects tables.
// - Durable blocks are indefinite: they ignore TTL entirely and clear only
//   via unblock(). TTL expiry frees *leases*; it never frees *blocks*.
import { randomUUID } from 'node:crypto';

export const DEFAULT_TTL_MS = 30_000;
export const DEFAULT_HEARTBEAT_MS = 10_000;

export interface Lease {
  readonly resources: readonly string[];
  readonly owner: string;
  readonly token: string;
  readonly fenceEpoch: number;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export interface LeaseManagerOptions {
  readonly ttlMs?: number;
  readonly heartbeatMs?: number;
  readonly now?: () => number;
}

export class LeaseError extends Error {
  override name = 'LeaseError';
}

export class StaleFenceError extends LeaseError {
  override name = 'StaleFenceError';
}

interface HeldLease {
  owner: string;
  token: string;
  expiresAt: number;
}

const assertResource = (value: string): void => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new LeaseError('resource must be a non-empty string');
  }
};

export class LeaseManager {
  private readonly ttlMs: number;
  private readonly clock: () => number;
  private readonly held = new Map<string, HeldLease>();
  private readonly epochs = new Map<string, number>();
  private readonly blocks = new Map<string, string>();
  private nextEpoch = 0;

  constructor(opts?: LeaseManagerOptions) {
    const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new LeaseError('ttlMs must be a positive finite number');
    }
    this.ttlMs = ttlMs;
    this.clock = opts?.now ?? (() => Date.now());
  }

  /** Acquire all resources atomically in sorted order, or hold none. */
  acquire(resources: string[], owner: string): Lease {
    if (typeof owner !== 'string' || owner.length === 0) {
      throw new LeaseError('owner must be a non-empty string');
    }
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new LeaseError('resources must be a non-empty array');
    }
    const sorted = [...new Set(resources)].sort();
    for (const resource of sorted) assertResource(resource);

    const now = this.clock();
    // Validate everything BEFORE mutating anything (all-or-nothing).
    for (const resource of sorted) {
      if (this.blocks.has(resource)) {
        throw new LeaseError(`resource is durably blocked: ${resource}`);
      }
      const current = this.held.get(resource);
      if (current !== undefined && current.expiresAt > now) {
        throw new LeaseError(`resource is held: ${resource}`);
      }
    }

    this.nextEpoch += 1;
    const epoch = this.nextEpoch;
    const token = randomUUID();
    const expiresAt = now + this.ttlMs;
    for (const resource of sorted) {
      this.held.delete(resource); // drop any lapsed entry
      this.held.set(resource, { owner, token, expiresAt });
      this.epochs.set(resource, epoch);
    }
    return { resources: sorted, owner, token, fenceEpoch: epoch, acquiredAt: now, expiresAt };
  }

  /** Release requires the exact owner + token pair. */
  release(resources: string[], owner: string, token: string): void {
    if (!Array.isArray(resources) || resources.length === 0) {
      throw new LeaseError('resources must be a non-empty array');
    }
    for (const resource of resources) {
      const current = this.held.get(resource);
      if (current === undefined) {
        throw new LeaseError(`no lease held: ${resource}`);
      }
      if (current.owner !== owner || current.token !== token) {
        throw new LeaseError(`release refused (owner/token mismatch): ${resource}`);
      }
    }
    for (const resource of resources) this.held.delete(resource);
  }

  /** Renew expiry without bumping the fence epoch. */
  heartbeat(lease: Pick<Lease, 'resources' | 'owner' | 'token'>): Lease {
    const now = this.clock();
    for (const resource of lease.resources) {
      const current = this.held.get(resource);
      if (current === undefined || current.expiresAt <= now) {
        throw new LeaseError(`lease lapsed: ${resource}`);
      }
      if (current.owner !== lease.owner || current.token !== lease.token) {
        throw new LeaseError(`heartbeat refused (owner/token mismatch): ${resource}`);
      }
    }
    const expiresAt = now + this.ttlMs;
    for (const resource of lease.resources) {
      const current = this.held.get(resource);
      if (current !== undefined) this.held.set(resource, { ...current, expiresAt });
    }
    const [first] = lease.resources;
    const fenceEpoch = first === undefined ? 0 : (this.epochs.get(first) ?? 0);
    return {
      resources: [...lease.resources].sort(),
      owner: lease.owner,
      token: lease.token,
      fenceEpoch,
      acquiredAt: now,
      expiresAt,
    };
  }

  /** True when the presented epoch is older than the latest acquire. */
  isStale(resource: string, fenceEpoch: number): boolean {
    return fenceEpoch < (this.epochs.get(resource) ?? 0);
  }

  /** Throw StaleFenceError for superseded holders; LeaseError for blocks. */
  assertUsable(resource: string, fenceEpoch: number): void {
    if (this.blocks.has(resource)) {
      throw new LeaseError(`resource is durably blocked: ${resource}`);
    }
    if (this.isStale(resource, fenceEpoch)) {
      throw new StaleFenceError(
        `stale fence: resource=${resource} presented=${fenceEpoch} current=${this.epochs.get(resource) ?? 0}`,
      );
    }
  }

  /** Durable, TTL-independent hold. Cleared only by unblock(). */
  block(resource: string, reason: string): void {
    assertResource(resource);
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new LeaseError('block reason must be a non-empty string');
    }
    this.blocks.set(resource, reason);
  }

  unblock(resource: string): void {
    this.blocks.delete(resource);
  }

  isBlocked(resource: string): boolean {
    return this.blocks.has(resource);
  }
}
