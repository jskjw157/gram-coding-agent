# Native channel fixture note (MAC-04 WP-14)

Fixture-level packaging contract for `platform/macos/operations-helper/`.
No real signing, no account mutation, no Keychain writes, no live credentials.

- Manifest: `helper-manifest.json` — fixed entry points (helper binary, XPC
  service id, launchd label), release provenance fields, allowlisted IPC
  operations only.
- Contract: `src/channel.ts` — peer identity (UID / signing requirement /
  audit session / generation), envelope v1 limits as constants, nonce
  handshake + timeout values recorded as DRAFT-proposal, NOT-APPROVED-FOR-PROD.
- Verifier: `src/peer-verifier.ts` (+ `FixturePeerVerifier.swift`, fixture
  only, never built in CI) — TeamID/bundle/uid/audit-session checks, FAIL
  CLOSED on adhoc/unknown signers, fixture signers only.
- Accounts: `src/accounts.ts` — mac_ops UID 502 OPERATIONS, mac_code UID 503
  CODING as config, not discovery (D5).
- Profiles: `src/profiles.ts` — profile dirs under domain homes, mode 0700.
- Tests: `src/native-channel.test.ts` — wrong-peer / replay / oversize /
  foreign-profile / unknown-signer refusals + allowlisted-operation-only
  acceptance. TDD RED (fail-open stub) → GREEN.

**Team ID NOT SUPPLIED — production signing BLOCKED.** Production needs a
real Apple Developer Team ID plus an approved decision for handshake/timeout
values; until then only fixture signers verify and no privileged execution
is unblocked.
