/**
 * Native channel contract — FIXTURE level (MAC-04 WP-14, decisions D5/D10).
 *
 * RED STUB (fail-open): every check accepts. GREEN step replaces each
 * `approve*` body with the fail-closed contract. No real signing, no
 * account mutation, no Keychain access, no live credentials.
 */

export interface PeerIdentity {
  readonly uid: number;
  readonly teamId: string;
  readonly bundleId: string;
  readonly auditSessionId: string;
  readonly generation: number;
}

export interface ChannelEnvelope {
  readonly version: 1;
  readonly operation: string;
  readonly peer: PeerIdentity;
  readonly nonce: string;
  readonly payloadBytes: number;
  readonly profilePath?: string;
}

export class NativeChannelError extends Error {
  override name = 'NativeChannelError';
}

/** RED STUB: accepts any envelope. GREEN: enforce allowlist + limits. */
export const approveEnvelope = (_envelope: ChannelEnvelope): void => undefined;

/** RED STUB: accepts any peer. GREEN: fail closed on wrong peer. */
export const approvePeer = (_peer: PeerIdentity): void => undefined;

/** RED STUB: accepts any nonce. GREEN: reject replays. */
export const approveNonce = (_nonce: string): void => undefined;
