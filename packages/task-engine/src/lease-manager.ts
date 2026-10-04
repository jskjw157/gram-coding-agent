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
// - Durable wiring (T4): every mutation emits a LeaseJournalEvent on the
//   optional journal port, and snapshot()/rehydrate() move the full lease
//   state (holds + epochs + blocks + nextEpoch) as plain JSON. The journal
//   is the WP-07 persistence target hook: the persistence lane backs it
//   with SQLite (M2 LockRepository row shape); this lane never touches the
//   database directly and never forks the M2 state machine.
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
  readonly journal?: LeaseJournal;
}

export type LeaseJournalEventKind = 'acquired' | 'heartbeat' | 'released' | 'blocked' | 'unblocked';

export interface LeaseJournalEvent {
  readonly kind: LeaseJournalEventKind;
  readonly resources: readonly string[];
  readonly owner: string | null;
  readonly fenceEpoch: number | null;
  readonly reason: string | null;
}

export type LeaseJournal = (event: LeaseJournalEvent) => void;

export interface PersistedLeaseHold {
  readonly resource: string;
  readonly owner: string;
  readonly token: string;
  readonly expiresAt: number;
}

export interface PersistedLeaseSnapshot {
  readonly version: 1;
  readonly ttlMs: number;
  readonly nextEpoch: number;
  readonly held: readonly PersistedLeaseHold[];
  readonly epochs: Readonly<Record<string, number>>;
  readonly blocks: Readonly<Record<string, string>>;
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
  private readonly journal: LeaseJournal;
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
    this.journal = opts?.journal ?? ((): void => {});
  }

  /** Plain-JSON durable state for the WP-07 persistence target. */
  snapshot(): PersistedLeaseSnapshot {
    const held: PersistedLeaseHold[] = [];
    for (const [resource, lease] of this.held) {
      held.push({ resource, owner: lease.owner, token: lease.token, expiresAt: lease.expiresAt });
    }
    held.sort((a, b) => (a.resource < b.resource ? -1 : a.resource > b.resource ? 1 : 0));
    const epochs: Record<string, number> = {};
    for (const [resource, epoch] of this.epochs) epochs[resource] = epoch;
    const blocks: Record<string, string> = {};
    for (const [resource, reason] of this.blocks) blocks[resource] = reason;
    return { version: 1, ttlMs: this.ttlMs, nextEpoch: this.nextEpoch, held, epochs, blocks };
  }

  /** Restore durable state after restart. Read-only: emits no journal events. */
  rehydrate(snapshot: PersistedLeaseSnapshot): void {
    if (snapshot.version !== 1) throw new LeaseError('unsupported lease snapshot version');
    if (snapshot.ttlMs !== this.ttlMs) throw new LeaseError('lease snapshot ttlMs mismatch');
    if (!Number.isSafeInteger(snapshot.nextEpoch) || snapshot.nextEpoch < 0) {
      throw new LeaseError('lease snapshot nextEpoch is invalid');
    }
    const held = new Map<string, HeldLease>();
    for (const entry of snapshot.held) {
      assertResource(entry.resource);
      if (typeof entry.owner !== 'string' || entry.owner.length === 0) {
        throw new LeaseError('lease snapshot owner is invalid');
      }
      if (typeof entry.token !== 'string' || entry.token.length === 0) {
        throw new LeaseError('lease snapshot token is invalid');
      }
      if (!Number.isFinite(entry.expiresAt)) throw new LeaseError('lease snapshot expiresAt is invalid');
      held.set(entry.resource, { owner: entry.owner, token: entry.token, expiresAt: entry.expiresAt });
    }
    const epochs = new Map<string, number>();
    for (const [resource, epoch] of Object.entries(snapshot.epochs)) {
      assertResource(resource);
      if (!Number.isSafeInteger(epoch) || epoch < 0) {
        throw new LeaseError(`lease snapshot epoch is invalid: ${resource}`);
      }
      epochs.set(resource, epoch);
    }
    const blocks = new Map<string, string>();
    for (const [resource, reason] of Object.entries(snapshot.blocks)) {
      assertResource(resource);
      if (typeof reason !== 'string' || reason.length === 0) {
        throw new LeaseError(`lease snapshot block reason is invalid: ${resource}`);
      }
      blocks.set(resource, reason);
    }
    this.held.clear();
    for (const [resource, lease] of held) this.held.set(resource, lease);
    this.epochs.clear();
    for (const [resource, epoch] of epochs) this.epochs.set(resource, epoch);
    this.blocks.clear();
    for (const [resource, reason] of blocks) this.blocks.set(resource, reason);
    this.nextEpoch = snapshot.nextEpoch;
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
    this.journal({ kind: 'acquired', resources: sorted, owner, fenceEpoch: epoch, reason: null });
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
    this.journal({ kind: 'released', resources: [...resources].sort(), owner, fenceEpoch: null, reason: null });
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
    this.journal({
      kind: 'heartbeat',
      resources: [...lease.resources].sort(),
      owner: lease.owner,
      fenceEpoch,
      reason: null,
    });
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

  /**
   * Full usability gate (T4). Without identity this is the legacy epoch-only
   * check, which alone is insufficient: it stays silent on expired or
   * released leases. With owner + token it additionally requires a live
   * current lease held by that exact identity at the current fence epoch,
   * plus the absence of a durable resource block.
   */
  assertUsable(resource: string, fenceEpoch: number, owner?: string, token?: string): void {
    if (this.blocks.has(resource)) {
      throw new LeaseError(`resource is durably blocked: ${resource}`);
    }
    if (owner === undefined || token === undefined) {
      if (this.isStale(resource, fenceEpoch)) {
        throw new StaleFenceError(
          `stale fence: resource=${resource} presented=${fenceEpoch} current=${this.epochs.get(resource) ?? 0}`,
        );
      }
      return;
    }
    const currentEpoch = this.epochs.get(resource) ?? 0;
    if (fenceEpoch !== currentEpoch) {
      throw new StaleFenceError(
        `stale fence: resource=${resource} presented=${fenceEpoch} current=${currentEpoch}`,
      );
    }
    const now = this.clock();
    const current = this.held.get(resource);
    if (current === undefined || current.expiresAt <= now) {
      throw new LeaseError(`no usable lease held: ${resource}`);
    }
    if (current.owner !== owner || current.token !== token) {
      throw new LeaseError(`lease identity mismatch: ${resource}`);
    }
  }

  /** Durable, TTL-independent hold. Cleared only by unblock(). */
  block(resource: string, reason: string): void {
    assertResource(resource);
    if (typeof reason !== 'string' || reason.length === 0) {
      throw new LeaseError('block reason must be a non-empty string');
    }
    this.blocks.set(resource, reason);
    this.journal({ kind: 'blocked', resources: [resource], owner: null, fenceEpoch: null, reason });
  }

  unblock(resource: string): void {
    this.blocks.delete(resource);
    this.journal({ kind: 'unblocked', resources: [resource], owner: null, fenceEpoch: null, reason: null });
  }

  isBlocked(resource: string): boolean {
    return this.blocks.has(resource);
  }
}
