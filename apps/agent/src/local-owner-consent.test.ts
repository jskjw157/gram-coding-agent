import { describe, expect, it } from 'vitest';
import { LocalOwnerConsent, type LocalOwnerOperation, type NativeOwnerPresenceVerifier } from './local-owner-consent.js';

const operation: LocalOwnerOperation = {
  taskId: 'fixture-task', action: 'protected-reveal', rootId: 'fixture', rootIdentity: '1:2',
  path: '.env', fileIdentity: '1:3', targetState: 'EXISTING', preimageDigest: 'a'.repeat(64),
  postimageDigest: null, destination: null, destinationRootIdentity: null,
};
// Synthetic verifier exercises the real state machine, not native human presence.
const verified: NativeOwnerPresenceVerifier = async challenge => ({
  status: 'VERIFIED', challengeId: challenge.challengeId, bindingDigest: challenge.bindingDigest,
  ownerId: 'fixture-owner', verifiedAt: challenge.issuedAt,
});
function fixture(verifier = verified) {
  let now = 1000;
  const consent = new LocalOwnerConsent({ verifier, now: () => now, ttlMs: 100 });
  return { consent, advance: () => { now += 101; } };
}
function granted(value: { capability: string; expiresAt: number } | null) {
  expect(value).not.toBeNull();
  if (value === null) throw new Error('Expected synthetic fixture grant');
  return value;
}

describe('local owner consent capabilities', () => {
  it('grants only a fresh trusted verification and consumes once', async () => {
    const { consent } = fixture();
    const grant = await consent.request(operation);
    expect(grant).not.toBeNull();
    expect(consent.consume(granted(grant).capability, operation)).toBe(true);
    expect(consent.consume(granted(grant).capability, operation)).toBe(false);
  });
  it.each([
    { taskId: 'other' }, { path: 'other.env' }, { action: 'credential-write' as const },
    { rootIdentity: '1:9' }, { rootId: 'other' }, { fileIdentity: '1:9' },
    { preimageDigest: 'b'.repeat(64) }, { postimageDigest: 'b'.repeat(64) },
    { destination: 'elsewhere' }, { destinationRootIdentity: '1:9' },
  ])('rejects changed operation %j without spending original grant', async changed => {
    const { consent } = fixture();
    const grant = await consent.request(operation);
    expect(consent.consume(granted(grant).capability, { ...operation, ...changed })).toBe(false);
    expect(consent.consume(granted(grant).capability, operation)).toBe(true);
  });
  it('rejects expired and restarted capabilities', async () => {
    const f = fixture();
    const grant = await f.consent.request(operation);
    expect(fixture().consent.consume(granted(grant).capability, operation)).toBe(false);
    f.advance();
    expect(f.consent.consume(granted(grant).capability, operation)).toBe(false);
  });
  it('allows exactly one concurrent consumer', async () => {
    const { consent } = fixture();
    const grant = await consent.request(operation);
    const results = await Promise.all(Array.from({ length: 10 }, async () => consent.consume(granted(grant).capability, operation)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it.each(['UNAVAILABLE', 'CANCELLED', 'DENIED'] as const)('fails closed on %s', async status => {
    expect(await fixture(async () => ({ status })).consent.request(operation)).toBeNull();
  });
  it('fails closed on verifier errors without exposing their bytes', async () => {
    expect(await fixture(async () => { throw new Error('fixture-sensitive-error'); }).consent.request(operation)).toBeNull();
  });
  it.each(['challenge', 'binding', 'time', 'owner'])('rejects invalid verifier %s proof', async field => {
    const verifier: NativeOwnerPresenceVerifier = async challenge => ({
      status: 'VERIFIED', challengeId: field === 'challenge' ? 'other' : challenge.challengeId,
      bindingDigest: field === 'binding' ? 'other' : challenge.bindingDigest,
      ownerId: field === 'owner' ? '' : 'fixture-owner', verifiedAt: field === 'time' ? 0 : challenge.issuedAt,
    });
    expect(await fixture(verifier).consent.request(operation)).toBeNull();
  });
  it('expires while waiting for native presence and snapshots mutable input', async () => {
    const f = fixture(async challenge => { f.advance(); return verified(challenge); });
    expect(await f.consent.request(operation)).toBeNull();
    const mutable = { ...operation };
    const g = fixture(async challenge => { mutable.path = 'changed'; return verified(challenge); });
    const grant = await g.consent.request(mutable);
    expect(g.consent.consume(granted(grant).capability, mutable)).toBe(false);
    expect(g.consent.consume(granted(grant).capability, operation)).toBe(true);
  });
  it('keeps paths out of receipts and content digests/extensions out of native challenges', async () => {
    let displayed = '';
    const f = fixture(async challenge => { displayed = JSON.stringify(challenge); return verified(challenge); });
    const grant = await f.consent.request(operation);
    expect(JSON.stringify(grant)).not.toContain('.env');
    expect(displayed).not.toContain(operation.preimageDigest ?? 'missing-fixture-digest');
    expect(await f.consent.request({ ...operation, content: 'fixture-secret' } as LocalOwnerOperation)).toBeNull();
  });
  it.each([
    { ...operation, action: 'credential-write' as const },
    { ...operation, fileIdentity: null, preimageDigest: null },
    { ...operation, destination: 'other', destinationRootIdentity: null },
    { ...operation, action: 'destructive' as const, fileIdentity: null, preimageDigest: null },
  ])('denies incomplete action-specific content or identity binding', async incomplete => {
    expect(await fixture().consent.request(incomplete)).toBeNull();
  });
  it('binds remote binary export separately from a protected local reveal', async () => {
    const f = fixture();
    const exportOperation = { ...operation, action: 'binary-export' as const };
    const grant = granted(await f.consent.request(exportOperation));
    expect(f.consent.consume(grant.capability, operation)).toBe(false);
    expect(f.consent.consume(grant.capability, exportOperation)).toBe(true);
  });
  it('binds a valid credential creation to an explicitly absent target and intended bytes', async () => {
    const f = fixture();const creation: LocalOwnerOperation = { ...operation, action: 'credential-write',
      targetState: 'ABSENT', fileIdentity: null, preimageDigest: null, postimageDigest: 'b'.repeat(64) };
    const grant = granted(await f.consent.request(creation));
    expect(f.consent.consume(grant.capability, { ...creation, targetState: 'EXISTING', fileIdentity: '1:8', preimageDigest: 'c'.repeat(64) })).toBe(false);
    expect(f.consent.consume(grant.capability, creation)).toBe(true);
  });
});
