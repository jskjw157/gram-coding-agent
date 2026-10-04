/**
 * Peer verifier — FIXTURE level (D10 peer enforcement).
 *
 * RED STUB (fail-open): accepts any signer. GREEN step asserts
 * TeamID/bundle/uid/audit-session checks and FAILS CLOSED on
 * adhoc/unknown signers. Fixture signers only.
 */

import type { PeerIdentity } from './channel.js';

export interface FixtureSigner {
  readonly teamId: string;
  readonly bundleId: string;
}

export class PeerVerifierError extends Error {
  override name = 'PeerVerifierError';
}

/** RED STUB: accepts any peer. GREEN: fail closed on adhoc/unknown signers. */
export const verifyPeerFixture = (
  _peer: PeerIdentity,
  _fixtureSigners: readonly FixtureSigner[],
): void => undefined;
