# MAC-02 C / #141 release packaging note (T7 repair)

Lane C delivery against the #141 contract (source of truth). Branch
`feat/mac02-release-packaging`; PR #168 target `feat/macos-service-lifecycle`.
Edits stay inside `platform/macos/package-release.*`,
`packages/macos-lifecycle/src/packaging-boundary.test.ts`, this note, and a
collection-only workflow step. Runtime/installer/diagnostic/CLI/shared
types/`index.ts`/package.json/lockfile untouched; PR #181 untouched.

## What was built

`platform/macos/package-release.mjs` — dependency-free (node:crypto,
node:fs, node:path, node:url) sealed release packager. Importing it performs
no I/O and spawns nothing. Exports:

- `packageRelease({sourceDir, stagingDir, releaseId, sourceCommit,
  lockBytes?, schemaCompatibility, tunnel?, additionalFiles?,
  additionalLinks?})` → `{stagingDir, releaseJson, digest, entries}`.
- `publishRelease({stagingDir, destDir})` → `{destDir, digest, releaseJson}`.
- Direct-execution CLI (`--source/--staging/--release-id/--source-commit/
  --schema-min/--schema-max/--lock-file/--tunnel-digest/--allow/--link/
  --publish`); prints `{stagingDir, destDir, digest}` as JSON.

Output is `release.json` with the EXACT consumer keys (`schemaVersion`,
`releaseId`, `sourceCommit`, `lockDigest`, `files`, `coreTools`,
`schemaCompatibility`, plus `tunnelCompatibilityDigest` only when the tunnel
is enabled). `coreTools` is always `['agent_health']`. Entries are
`{path,sha256,executable}` or `{path,target}`, sorted by path; bytes are
canonical (fixed key order, compact JSON, trailing newline) so the digest is
stable across runs. No new manifest consumer: acceptance goes through the
existing `inspectRelease`.

Required entries: `bin/node`, `apps/agent/dist/main.js`,
`packages/macos-lifecycle/dist/supervisor-cli.js`, `pnpm-lock.yaml`,
`bin/file-acl`, `bin/peer-owner`, plus `bin/tunnel-client` when the tunnel is
enabled. A real base without `supervisor-cli.js` fails closed (no stubs);
complete fixtures live in temp dirs only.

Binding: `sourceCommit` (40 hex) and `schemaCompatibility` are bound verbatim
(never guessed); `lockDigest` is the sha256 of the actual staged
`pnpm-lock.yaml`, and a supplied `lockBytes` that differs is refused.

## Refusals (all covered by tests)

- `DIRTY_SOURCE`: `.git` entries, secret-bearing basenames (`.env*`,
  `*.pem`, `*keychain*`), control-char names.
- `EXTRA_FILE`: any undeclared file/link/directory in the source scan.
- `MISSING_FILE`: any required entry (or declared link) absent.
- `EXECUTABLE_MISMATCH`: `bin/*` must be executable, all other files not.
- `SYMLINK_ESCAPE`: absolute, escaping, cyclic, file-traversing, or
  unresolvable internal link targets (lexical resolution mirrors the
  consumer's inventory semantics; only declared links are preserved).
- `LOCK_MISMATCH`, `OUTPUT_EXISTS` (staging/dest already present),
  `INVALID_*` for malformed ids/commits/ranges/options.

Staging and final publication are separate: `packageRelease` never touches
`destDir`; `publishRelease` refuses an existing destination. Failures remove
only the newly created staging/dest; source and pre-existing output are never
modified or purged. No secrets in bundle, tests, or logs; no network,
keychain, subprocess, signing, or install.

## Prior divergent implementation (replaced additively)

The earlier `platform/macos/packaging/release-packaging.mjs` wrote a
`manifest.json` schema (`{schemaVersion, releaseId, entries:[{path,sha256,
bytes,mode}], fileCount, totalBytes, manifestDigest}`) that no
`inspectRelease` consumer reads. It and its spec are removed in this repair;
no history rewrite. Content-shape credential scanning was intentionally not
carried over (binary-hostile); secret basenames and the strict allowlist
enforce the same exclusion at the boundary.

## Verification (TDD RED→GREEN)

- RED: new contract tests failed on the missing module (`ERR_MODULE_NOT_FOUND`
  in `node --test`; `Cannot find module` in vitest), and the old impl was
  shown to emit non-contract keys (`schemaVersion,releaseId,entries,
  fileCount,totalBytes,manifestDigest`). Logs `/tmp/mac02-red-node.log`,
  `/tmp/mac02-red-vitest.log` (outside repo).
- GREEN: `node --test platform/macos/package-release.test.mjs` → 11 pass;
  `pnpm --filter @gram/macos-lifecycle test --run
  src/packaging-boundary.test.ts` → 7 pass (incl. `inspectRelease`
  round-trip accept + mutate/link/hash refusal cases, tunnel on/off).
- Full package suite + `pnpm lint` + `pnpm typecheck` status in PR body.
  Workflow gains one collection step only
  (`Collect sealed release packaging contract tests`, mirroring the T4
  `b1b8478` step style); the vitest round-trip is collected by the existing
  `Behavioral tests` step.

## Status

`IMPLEMENTED / INTEGRATION_PENDING`. No deployable release is claimed: real
release creation waits on lane A's execution entry (`supervisor-cli.js`) and
actual native binaries. A lane-A request (unchanged): register any additional
compiled runtime beyond the required set via `additionalFiles` allowlist.
