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
- Accounts: `src/accounts.ts` — SYNTHETIC EXAMPLE VALUES ONLY
  (`EXAMPLE_OPS_UID` / `EXAMPLE_CODING_UID`, `EXAMPLE_OPS_USER` /
  `EXAMPLE_CODING_USER`). They resemble UID values but are NEVER production
  config sources. The real UID-role binding comes from target-Mac account
  discovery at WP-20; no account/user mutation happens here.
- Profiles: `src/profiles.ts` — profile dirs under domain homes, mode 0700.
- Tests: `src/native-channel.test.ts` — wrong-peer / replay / oversize /
  foreign-profile / unknown-signer refusals + allowlisted-operation-only
  acceptance. TDD RED (fail-open stub) → GREEN.

**Team ID NOT SUPPLIED — production signing BLOCKED.** Production needs a
real Apple Developer Team ID plus an approved decision for handshake/timeout
values; until then only fixture signers verify and no privileged execution
is unblocked.

**Synthetic-UID repair (T11).** No file in this lane carries real target-Mac
account identifiers: UIDs appear only as `EXAMPLE_*` constants and example
usernames carry an `example_` prefix. `grep` for production account names
returns nothing in this lane. CI collects the fixture tests via the
dedicated `ops-native-channel` workflow (path-filtered to this lane),
mirroring how `macos-lifecycle.yml` collects its lane tests — shared CI
(`ci.yml`, workspace, root vitest projects) is untouched.
