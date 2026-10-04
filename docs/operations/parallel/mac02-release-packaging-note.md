# MAC-02 C / #141 release packaging note

Lane C greenfield delivery. Base `origin/feat/macos-service-lifecycle` at
`3d0187c`; branch `feat/mac02-release-packaging`; PR target
`feat/macos-service-lifecycle`. No edits outside
`platform/macos/packaging/**` and this note; `packages/macos-lifecycle/src/**`
untouched. No secrets (tokens/keys/certs/.env/keychain) in bundle, tests, or
logs: fixtures are synthetic repeated-character canaries, findings report rule
names only.

## What was built

`platform/macos/packaging/release-packaging.mjs` — dependency-free (node:crypto,
node:fs, node:path) deterministic bundle writer:

- Layout: `<dest>/manifest.json` + `<dest>/payload/<sorted relative paths>`.
- Manifest: `{schemaVersion:1, releaseId, entries:[{path,sha256,bytes,mode}],
  fileCount, totalBytes, manifestDigest}` where `manifestDigest` is sha256 over
  the canonical `{schemaVersion, releaseId, entries}` encoding. Entries sorted
  by path; rewrite is byte-identical.
- Validation: releaseId `^[a-z0-9][a-z0-9._-]{0,63}$`; clean relative posix
  paths only (no absolute, `..`, backslash, empty segments); unique paths;
  modes `0644` (data, default) or `0600` (config) only.
- No-secrets: content scan for github-token, aws-access-key, pem-private-key,
  slack-token, openai-key, google-api-key; secret-bearing basenames rejected
  (`.env*`, `*.pem`, `*keychain*`); payload containing `0.0.0.0` rejected
  (loopback-only, AGENTS.md). No network, keychain, subprocess, or lifecycle
  engine imports.

Tests: `platform/macos/packaging/release-packaging.test.mjs` (`node --test`),
7 tests across layout, manifest, no-secrets scan, permissions.

## Verification (TDD)

- RED (impl moved aside): `node --test "platform/macos/packaging/*.test.mjs"` →
  1 fail (`ERR_MODULE_NOT_FOUND` for `./release-packaging.mjs`). Log
  `/tmp/mac02-red.log` (outside repo, no secrets).
- GREEN: same command → 7 pass / 0 fail. Log `/tmp/mac02-green.log`.
- Regression: `pnpm --filter @gram/macos-lifecycle test` — untouched lane,
  expected green (see PR body for observed counts).
- `pnpm typecheck`, `pnpm lint`: no new inputs (platform/ is outside workspace
  lint/typecheck projects); observed status in PR body.
- Secret scan: `grep -rniE` for credential shapes over the two allowed paths
  returns only synthetic canary builders (`'ghp_' + 'A'.repeat(36)` style, no
  contiguous literal) — zero real secrets. No values echoed in code, tests,
  or logs.

## Status

Draft delivery only. No installed service, signing, notarization, or
user-device acceptance is claimed. Consumer: installer lane verifies
`manifestDigest` before install; CLI preview digest can be sourced from the
manifest. Follow-ups (not in this lane): signature/provenance envelope,
plist authoring from manifest, installer-side verification wiring.
