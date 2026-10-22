# Issue 228 activation gates — 2026-10-22

This is a preparation and stop-condition record. It neither activates a release
nor changes the accepted v0.1.0 release/tag. The owner authorized reviewed Issue
228 merges and safe deployment; a new generic command API, policy bypass, trust
key or permission grant is outside that authorization.

## Current stop

The unsigned protected viewer was rejected by Smart App Control on the target
Windows machine. Preserve its diagnostics and obtain an equivalent artifact
through an existing authorized publicly trusted signing identity/service. No
code-signing certificate was found in the current-user or local-machine personal
certificate stores. That does not establish whether an external signing service
exists. Do not disable policy, rename/recompile to evade the observed rejection,
substitute an old viewer, or generate/import a new trust key as a workaround.

Verify signer, source/build provenance and final signed SHA-256 before updating
installation pins. A valid signature does not alone prove admission under every
active policy. Actual viewer launch, fresh Hello, local-only rendering and capture
behavior remain required. Native Hello verification and native window cancellation
already passed with a synthetic no-effect request; those do not prove the viewer.

## Integration and artifact binding

1. Keep PR 229 stacked on PR 227. Recheck live SHAs, reviews and required CI after
   each change. Merge the reviewed completion into the starter first, then verify
   the combined PR before main. Do not ship the earlier limited starter alone.
2. Bind the final merged source, production imports, all dist files, native
   sources/compiler/build outputs, final signed helpers, unchanged M5 entry and
   verified Node/pnpm runtime. Historical candidate CI covers only its own SHA.
3. Put production code/imports and rollback code outside the newly writable home,
   under protected root-owned directories. Do not load dependencies from a writable
   development checkout. Retain the original release and all historical evidence.
4. Use the [fixed Windows installer](../../scripts/windows-owner-workspace-install.md)
   for three versioned helpers. Its 27 non-elevated checks and independent review
   passed, including creation-time protected ACL application. Actual elevated
   installation and ordinary-user replacement/write/ACL denial checks are still
   required. The installer never elevates itself or changes application policy.

## Trusted configuration

- Current measured roots are C: (`/mnt/c`) and the owner's WSL home. Enumerate
  drives again before installation; additional roots require trusted local
  configuration, not a caller-supplied host path. Keep multi-root access.
- Use a root-owned `/etc/gram-coding-agent/owner-workspace.json` with protected
  ancestors, exact artifact digests and actual root/vault identities. Existing
  private state and secret directories remain private and excluded.
- Explicitly protect Windows controller credentials and the entire registered
  WSL storage container, including `ext4.vhdx`, against Windows-side access.
  Inventory nonstandard controller-secret locations before activation. Do not
  replace content-based preview screening with filename-wide `.env` denial.
- Linux capture and native recovery vaults must be outside the authorized home,
  private, on the supported original ext4 volume and identity-pinned. The Windows
  vault must be private on C:, separate from the read/execute-only helper tree.
  Preserve encrypted recovery records/keys and native inode/tree descriptors.

## Fresh preservation and service transition

The preparation backup at
`/var/lib/gram-issue228-preparation/20261022T005239Z` passed restored-copy checks
for both existing SQLite databases, private configuration and seven historical
worktrees. This does not substitute for a fresh activation checkpoint.

Replace the old Issue 226 controller's historical SHA/CI bindings and two-DB
inventory with a reviewed procedure for the final artifacts. It must inventory
the owner journal, recovery key/records, private native vaults/captures and current
process generations in addition to the main/observation DBs and old worktrees.

Immediately before activation, prove idle Tasks, zero unexplained row/file locks
and no outstanding native operation. Take online SQLite backups, restore-check
logical content, preserve staged/unstaged worktrees and acquire the reviewed
idle/write barriers. Freeze PID/start ticks/boot/cgroup identities. Stop tunnel,
then agent, normally; prove owner/descendant exit and stopped heartbeats. Never
force-kill or release a lock by TTL to make a gate pass.

Apply only the exact reviewed artifacts/configuration. Start agent, then tunnel.
Verify source/dist/runtime/helper identities, Node/npm, health, private-path
denials, journal/recovery semantics and unchanged historical data fingerprints.

## External acceptance and recovery

The external ChatGPT connector must discover and execute the new tools. An
internal tools/list response or old health call is insufficient. Read actual
`C:\source\mc-web` listing/source without mutation. In a separate disposable
fixture, verify create/CAS-edit/patch/search/copy/move/trash/restore, binary and
sensitive-content authorization, Git inspection/registration, named isolated
commands and Task evidence. Correlate each result to the deployed SHA and journal.

Re-run necessary full CI and native checks on the final integrated SHA. Preserve
failed probes, historical Tasks and backups. Do not mark Issue 228 complete until
the actual external and operational gates pass.

If activation fails, stop further changes and preserve current state/evidence.
Do not restore an old database or automatically reverse owner filesystem effects.
Do not assume an old reader understands persisted `LOCAL_COMMAND` records or the
new recovery journal: validate compatibility on isolated backup copies first.
Keep the service stopped if no reviewed security-equivalent recovery exists;
there is no automatic security-degrading old-build rollback.
