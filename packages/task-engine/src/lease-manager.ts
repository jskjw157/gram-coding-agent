// lease-manager.ts — RED stub (not implemented).
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

export class LeaseManager {
  constructor(_opts?: LeaseManagerOptions) {
    throw new Error('not implemented');
  }

  acquire(_resources: string[], _owner: string): Lease {
    throw new Error('not implemented');
  }

  release(_resources: string[], _owner: string, _token: string): void {
    throw new Error('not implemented');
  }

  heartbeat(_lease: Pick<Lease, 'resources' | 'owner' | 'token'>): Lease {
    throw new Error('not implemented');
  }

  isStale(_resource: string, _fenceEpoch: number): boolean {
    throw new Error('not implemented');
  }

  assertUsable(_resource: string, _fenceEpoch: number): void {
    throw new Error('not implemented');
  }

  block(_resource: string, _reason: string): void {
    throw new Error('not implemented');
  }

  unblock(_resource: string): void {
    throw new Error('not implemented');
  }

  isBlocked(_resource: string): boolean {
    throw new Error('not implemented');
  }
}
