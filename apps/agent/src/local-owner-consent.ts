import { createHmac, randomBytes, randomUUID } from 'node:crypto';

export interface LocalOwnerOperation {
  taskId: string;
  action: 'protected-reveal' | 'credential-write' | 'destructive';
  rootId: string;
  rootIdentity: string;
  path: string;
  fileIdentity: string | null;
  preimageDigest: string | null;
  postimageDigest: string | null;
  destination: string | null;
  destinationRootIdentity: string | null;
}
export interface NativeOwnerChallenge {
  readonly challengeId: string;
  readonly bindingDigest: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Render as inert text only. Never render caller/file supplied HTML or instructions. */
  readonly target: Readonly<Pick<LocalOwnerOperation, 'action' | 'rootId' | 'path' | 'destination'>>;
}
export type NativeOwnerPresenceResult =
  | { status: 'VERIFIED'; challengeId: string; bindingDigest: string; ownerId: string; verifiedAt: number }
  | { status: 'UNAVAILABLE' | 'CANCELLED' | 'DENIED' };
/** Trusted composition-only port: must authenticate the enrolled owner using native
 * user presence and bind its proof to this exact challenge. A local CLI/button,
 * remote approval_approve or caller-supplied VERIFIED object is not an implementation.
 * Protected reveal displays locally; neither this port nor receipts carry file bytes.
 */
export type NativeOwnerPresenceVerifier = (challenge: NativeOwnerChallenge) => Promise<NativeOwnerPresenceResult>;

const KEYS = ['taskId', 'action', 'rootId', 'rootIdentity', 'path', 'fileIdentity',
  'preimageDigest', 'postimageDigest', 'destination', 'destinationRootIdentity'] as const;
const IDENTITY = /^\d+:\d+$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
function safePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 &&
    !/[\\:]/u.test(value) && !Array.from(value).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    value.split('/').every(p => p !== '' && p !== '.' && p !== '..');
}
function snapshot(input: LocalOwnerOperation): LocalOwnerOperation | null {
  if (!input || typeof input !== 'object' || Object.keys(input).length !== KEYS.length ||
      Object.keys(input).some(k => !KEYS.includes(k as typeof KEYS[number]))) return null;
  const op = Object.fromEntries(KEYS.map(k => [k, input[k]])) as unknown as LocalOwnerOperation;
  if (typeof op.taskId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(op.taskId) ||
      !['protected-reveal', 'credential-write', 'destructive'].includes(op.action) ||
      typeof op.rootId !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/u.test(op.rootId) ||
      typeof op.rootIdentity !== 'string' || !IDENTITY.test(op.rootIdentity) || !safePath(op.path) ||
      (op.fileIdentity !== null && (typeof op.fileIdentity !== 'string' || !IDENTITY.test(op.fileIdentity))) ||
      [op.preimageDigest, op.postimageDigest].some(d => d !== null && (typeof d !== 'string' || !DIGEST.test(d))) ||
      (op.destination !== null && !safePath(op.destination)) ||
      (op.destinationRootIdentity !== null && (typeof op.destinationRootIdentity !== 'string' || !IDENTITY.test(op.destinationRootIdentity)))) return null;
  return Object.freeze(op);
}

export class LocalOwnerConsent {
  private readonly key = randomBytes(32);
  private readonly grants = new Map<string, { binding: string; issuedAt: number; expiresAt: number }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly verifier: NativeOwnerPresenceVerifier;

  constructor(options: { verifier: NativeOwnerPresenceVerifier; now?: () => number; ttlMs?: number }) {
    this.verifier = options.verifier;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 60_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0 || this.ttlMs > 120_000) {
      throw new Error('Invalid owner consent lifetime');
    }
  }

  private digest(value: string): string {
    return createHmac('sha256', this.key).update(value).digest('hex');
  }
  private prune(now: number): void {
    for (const [key, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(key);
  }

  async request(input: LocalOwnerOperation): Promise<{ capability: string; expiresAt: number } | null> {
    try {
      const operation = snapshot(input);
      if (operation === null) return null;
      const issuedAt = this.now();
      if (!Number.isSafeInteger(issuedAt)) return null;
      this.prune(issuedAt);
      if (this.grants.size >= 256) return null;
      const bindingDigest = this.digest(JSON.stringify(operation));
      const expiresAt = issuedAt + this.ttlMs;
      const challenge = Object.freeze({ challengeId: randomUUID(), bindingDigest, issuedAt, expiresAt,
        target: Object.freeze({ action: operation.action, rootId: operation.rootId,
          path: operation.path, destination: operation.destination }) });
      const result = await this.verifier(challenge);
      const now = this.now();
      if (result.status !== 'VERIFIED' || result.challengeId !== challenge.challengeId ||
          result.bindingDigest !== bindingDigest || typeof result.ownerId !== 'string' ||
          !/^[A-Za-z0-9_.:-]{1,128}$/u.test(result.ownerId) ||
          !Number.isSafeInteger(result.verifiedAt) || result.verifiedAt < issuedAt ||
          result.verifiedAt > now || !Number.isSafeInteger(now) || now < issuedAt || now >= expiresAt || this.grants.size >= 256) return null;
      const capability = randomBytes(32).toString('hex');
      this.grants.set(this.digest(capability), { binding: bindingDigest, issuedAt, expiresAt });
      return { capability, expiresAt };
    } catch { return null; }
  }

  /** Synchronous compare-and-delete has no await boundary: one consumer per
   * instance can spend a grant. Never refund a consumed grant after effect failure.
   * Caller must revalidate live file/root/content identity immediately before use.
   */
  consume(capability: string, input: LocalOwnerOperation): boolean {
    try {
      const operation = snapshot(input);
      if (operation === null || typeof capability !== 'string' || !DIGEST.test(capability)) return false;
      const now = this.now();
      this.prune(now);
      const key = this.digest(capability);
      const grant = this.grants.get(key);
      if (grant === undefined || grant.binding !== this.digest(JSON.stringify(operation)) ||
          !Number.isSafeInteger(now) || now < grant.issuedAt || now >= grant.expiresAt) return false;
      this.grants.delete(key);
      return true;
    } catch { return false; }
  }
}
