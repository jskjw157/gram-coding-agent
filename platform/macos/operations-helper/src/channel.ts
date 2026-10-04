/**
 * Native channel contract — FIXTURE level (MAC-04 WP-14, decisions D5/D10).
 *
 * Peer identity: UID + signing requirement (TeamID/bundle) + audit
 * session + generation. Envelope v1 limits are constants. Nonce-handshake
 * and timeout values below are RECORDED DRAFT-PROPOSAL values, clearly
 * marked NOT-APPROVED-FOR-PROD — they settle nothing for production.
 *
 * No real signing, no account mutation, no Keychain access, no live
 * credentials. This helper instance serves the OPERATIONS domain only
 * (mac_ops, UID 502); any other UID is a wrong peer.
 */

import { domainAccountFor } from './accounts.js';

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

/** Envelope v1 fixed limits (contract constants). */
export const ENVELOPE_VERSION = 1 as const;
export const MAX_ENVELOPE_BYTES = 65_536;
export const MAX_PAYLOAD_BYTES = 32_768;
export const MAX_OPERATION_NAME_LENGTH = 128;

/**
 * DRAFT-proposal handshake/timeout values — NOT-APPROVED-FOR-PROD.
 * Recorded here so fixture timing is deterministic; production values
 * require an approved decision that does not exist yet.
 */
export const DRAFT_NOT_APPROVED_FOR_PROD = true as const;
export const DRAFT_NONCE_BYTES = 32;
export const DRAFT_HANDSHAKE_TIMEOUT_MS = 5_000;
export const DRAFT_SESSION_TTL_MS = 600_000;
export const DRAFT_CLOCK_SKEW_MS = 30_000;

/** In-memory single-use nonce registry (fixture scope only). */
const seenNonces = new Set<string>();

/** Reset the fixture nonce registry. Tests only — never production. */
export const resetFixtureNonces = (): void => {
  seenNonces.clear();
};

export const approveNonce = (nonce: string): void => {
  if (nonce.length === 0) {
    throw new NativeChannelError('channel rejected: nonce must be bound (non-empty)');
  }
  if (seenNonces.has(nonce)) {
    throw new NativeChannelError(`channel rejected: nonce replay forbidden (${nonce})`);
  }
  seenNonces.add(nonce);
};

export const approvePeer = (peer: PeerIdentity): void => {
  const expectedUid = domainAccountFor('OPERATIONS').uid;
  if (peer.uid !== expectedUid) {
    throw new NativeChannelError(
      `channel rejected: wrong peer uid ${peer.uid}, helper serves OPERATIONS uid ${expectedUid}`,
    );
  }
  if (peer.auditSessionId.length === 0) {
    throw new NativeChannelError('channel rejected: peer audit session must be bound');
  }
  if (peer.generation < 1) {
    throw new NativeChannelError('channel rejected: peer generation must be >= 1');
  }
};

export const approveEnvelope = (envelope: ChannelEnvelope): void => {
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new NativeChannelError(
      `channel rejected: envelope version ${envelope.version} unsupported, want v${ENVELOPE_VERSION}`,
    );
  }
  if (envelope.operation.length === 0) {
    throw new NativeChannelError('channel rejected: operation must be bound (non-empty)');
  }
  if (envelope.operation.length > MAX_OPERATION_NAME_LENGTH) {
    throw new NativeChannelError(
      `channel rejected: operation name exceeds ${MAX_OPERATION_NAME_LENGTH} chars`,
    );
  }
  if (envelope.payloadBytes < 0 || envelope.payloadBytes > MAX_PAYLOAD_BYTES) {
    throw new NativeChannelError(
      `channel rejected: oversize payload ${envelope.payloadBytes} bytes, limit ${MAX_PAYLOAD_BYTES}`,
    );
  }
  approvePeer(envelope.peer);
  approveNonce(envelope.nonce);
};
