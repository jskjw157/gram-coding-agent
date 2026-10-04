/**
 * Native channel + domain runtime packaging contract — FIXTURE level.
 *
 * RED: all refusal tests fail-open on the stub (no throw). GREEN: the
 * contract enforces each refusal. No real signing, no account mutation,
 * no live credentials. Node/vitest only; Swift sources (if any) are
 * fixture-only and never built in CI.
 */
import { describe, expect, it } from 'vitest';
import {
  approveEnvelope,
  approveNonce,
  approvePeer,
  type ChannelEnvelope,
  type PeerIdentity,
} from './channel.js';
import {
  domainAccountFor,
  EXAMPLE_CODING_UID,
  EXAMPLE_CODING_USER,
  EXAMPLE_OPS_UID,
  EXAMPLE_OPS_USER,
  SYNTHETIC_EXAMPLE,
} from './accounts.js';
import { approveProfilePath } from './profiles.js';
import { approveOperation, type HelperManifestShape } from './manifest.js';
import { verifyPeerFixture } from './peer-verifier.js';

const opsPeer: PeerIdentity = {
  uid: EXAMPLE_OPS_UID,
  teamId: 'FIXTURE-TEAMID-OPS',
  bundleId: 'agent.gram.operations-helper',
  auditSessionId: 'fixture-audit-session-ops',
  generation: 1,
};

const baseEnvelope: ChannelEnvelope = {
  version: 1,
  operation: 'helper.ping',
  peer: opsPeer,
  nonce: 'fixture-nonce-001',
  payloadBytes: 128,
};

const fixtureManifest: HelperManifestShape = {
  entryPoints: {
    helper: '/Library/PrivilegedHelperTools/agent.gram.operations-helper',
  },
  release: { buildMode: 'FIXTURE' },
  allowlistedOperations: ['helper.ping', 'helper.profile.open'],
};

describe('native channel refusals (fail closed)', () => {
  it('refuses a wrong peer (uid mismatch)', () => {
    expect(() =>
      approvePeer({ ...opsPeer, uid: EXAMPLE_CODING_UID }),
    ).toThrow(/wrong peer|peer/i);
  });

  it('refuses a replayed nonce', () => {
    approveNonce('fixture-nonce-replay-1');
    expect(() => approveNonce('fixture-nonce-replay-1')).toThrow(/replay/i);
  });

  it('refuses an oversize envelope', () => {
    const oversize: ChannelEnvelope = { ...baseEnvelope, payloadBytes: 4_000_000 };
    expect(() => approveEnvelope(oversize)).toThrow(/oversize|limit|bytes/i);
  });

  it('refuses a foreign profile path (outside domain home)', () => {
    expect(() =>
      approveProfilePath('/Users/example_code/Profiles/Default', '/Users/example_ops'),
    ).toThrow(/foreign|profile/i);
  });

  it('refuses an unknown signer (adhoc)', () => {
    expect(() =>
      verifyPeerFixture(
        { ...opsPeer, teamId: 'adhoc' },
        [{ teamId: 'FIXTURE-TEAMID-OPS', bundleId: 'agent.gram.operations-helper' }],
      ),
    ).toThrow(/signer|adhoc|unknown/i);
  });
});

describe('domain runtime packaging contract', () => {
  it('maps EXAMPLE_CODING_USER / EXAMPLE_CODING_UID to CODING (synthetic example, not discovery)', () => {
    expect(domainAccountFor('CODING')).toEqual({
      user: EXAMPLE_CODING_USER,
      uid: EXAMPLE_CODING_UID,
      domain: 'CODING',
    });
  });

  it('maps EXAMPLE_OPS_USER / EXAMPLE_OPS_UID to OPERATIONS (synthetic example, not discovery)', () => {
    expect(domainAccountFor('OPERATIONS')).toEqual({
      user: EXAMPLE_OPS_USER,
      uid: EXAMPLE_OPS_UID,
      domain: 'OPERATIONS',
    });
  });

  it('exposes UIDs as synthetic examples only, never production config sources', () => {
    expect(SYNTHETIC_EXAMPLE).toBe(true);
    expect(EXAMPLE_OPS_UID).toBe(502);
    expect(EXAMPLE_CODING_UID).toBe(503);
    expect(EXAMPLE_OPS_USER.startsWith('example_')).toBe(true);
    expect(EXAMPLE_CODING_USER.startsWith('example_')).toBe(true);
    expect(domainAccountFor('OPERATIONS')).toEqual({
      user: EXAMPLE_OPS_USER,
      uid: EXAMPLE_OPS_UID,
      domain: 'OPERATIONS',
    });
    expect(domainAccountFor('CODING')).toEqual({
      user: EXAMPLE_CODING_USER,
      uid: EXAMPLE_CODING_UID,
      domain: 'CODING',
    });
  });

  it('accepts allowlisted operations only', () => {
    expect(() =>
      approveOperation('helper.ping', fixtureManifest),
    ).not.toThrow();
    expect(() =>
      approveOperation('helper.profile.open', fixtureManifest),
    ).not.toThrow();
    expect(() =>
      approveOperation('helper.keychain.export', fixtureManifest),
    ).toThrow(/allowlist|forbidden|operation/i);
  });
});
