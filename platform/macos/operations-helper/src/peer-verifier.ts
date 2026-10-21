/**
 * Peer verifier — FIXTURE level (D10 peer enforcement).
 *
 * Asserts TeamID/bundle/uid/audit-session checks and FAILS CLOSED on
 * adhoc/unknown signers. Fixture signers only.
 *
 * PRODUCTION GATE: a real Apple Developer Team ID is NOT SUPPLIED, so
 * production signing/execution stays BLOCKED (see assertProductionUnblocked).
 * No real codesign is performed here — this is a fixture allowlist check.
 */

import type { PeerIdentity } from './channel.js';
import { EXAMPLE_CODING_UID, EXAMPLE_OPS_UID } from './accounts.js';

export interface FixtureSigner {
  readonly teamId: string;
  readonly bundleId: string;
}

export class PeerVerifierError extends Error {
  override name = 'PeerVerifierError';
}

/** Production Team ID: NOT SUPPLIED — production signing/execution is BLOCKED. */
export const PRODUCTION_TEAM_ID: string | null = null;

/** Always throws: production peer verification cannot run without a real Team ID. */
export const assertProductionUnblocked = (): void => {
  throw new PeerVerifierError(
    'Team ID NOT SUPPLIED — production signing BLOCKED; fixture signers only',
  );
};

const isAdhocSigner = (teamId: string): boolean =>
  teamId.length === 0 || teamId === 'adhoc' || teamId === '-';

/** Fail-closed fixture peer check: TeamID + bundle allowlist, uid, audit session. */
export const verifyPeerFixture = (
  peer: PeerIdentity,
  fixtureSigners: readonly FixtureSigner[],
): void => {
  if (isAdhocSigner(peer.teamId)) {
    throw new PeerVerifierError(
      `peer refused: adhoc signer '${peer.teamId}' never trusted, known TeamID required`,
    );
  }
  const known = fixtureSigners.some(
    (signer) => signer.teamId === peer.teamId && signer.bundleId === peer.bundleId,
  );
  if (!known) {
    throw new PeerVerifierError(
      `peer refused: unknown signer teamId=${peer.teamId} bundleId=${peer.bundleId}`,
    );
  }
  if (peer.uid !== EXAMPLE_OPS_UID && peer.uid !== EXAMPLE_CODING_UID) {
    throw new PeerVerifierError(
      `peer refused: unknown uid ${peer.uid}, want synthetic EXAMPLE_OPS_UID or EXAMPLE_CODING_UID`,
    );
  }
  if (peer.auditSessionId.length === 0) {
    throw new PeerVerifierError('peer refused: audit session must be bound');
  }
};
