#!/bin/bash
set -euo pipefail
umask 077

if [[ "${GITHUB_ACTIONS:-}" != 'true' || "$(/usr/bin/uname -s)" != 'Darwin' || "$(/usr/bin/uname -m)" != 'arm64' ]]; then
  echo 'CI_ONLY' >&2
  exit 77
fi
if [[ "${EUID:-$(/usr/bin/id -u)}" -ne 0 ]]; then
  echo 'ROOT_REQUIRED' >&2
  exit 77
fi
if [[ $# -ne 3 ]]; then
  echo 'usage: disposable-launchd-apply.sh <sealed-release-dir> <independent-file-acl-helper> <expected-release-digest>' >&2
  exit 64
fi

SOURCE_RELEASE="$1"
ACL_HELPER="$2"
EXPECTED_DIGEST="$3"
VENDOR_ROOT='/Library/Application Support/HAAR'
ROOT="$VENDOR_ROOT/GramAgent"
CORE_LABEL='com.haar.gram-agent.core'
TUNNEL_LABEL='com.haar.gram-agent.tunnel'
CORE_PLIST="/Library/LaunchDaemons/$CORE_LABEL.plist"
TUNNEL_PLIST="/Library/LaunchDaemons/$TUNNEL_LABEL.plist"
CREATED_USER=0

cleanup() {
  set +e
  /bin/launchctl bootout "system/$TUNNEL_LABEL" >/dev/null 2>&1 || true
  /bin/launchctl bootout "system/$CORE_LABEL" >/dev/null 2>&1 || true
  /bin/rm -f "$CORE_PLIST" "$TUNNEL_PLIST"
  /bin/rm -rf "$ROOT"
  if [[ "$CREATED_USER" -eq 1 ]]; then
    /usr/bin/dscl . -delete /Users/gram-agent >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[[ -d "$SOURCE_RELEASE" && ! -L "$SOURCE_RELEASE" ]] || { echo 'INVALID_RELEASE_SOURCE' >&2; exit 2; }
[[ -f "$SOURCE_RELEASE/release.json" && ! -L "$SOURCE_RELEASE/release.json" ]] || { echo 'INVALID_RELEASE_SOURCE' >&2; exit 2; }
[[ -f "$ACL_HELPER" && ! -L "$ACL_HELPER" && -x "$ACL_HELPER" ]] || { echo 'INVALID_ACL_HELPER' >&2; exit 2; }
[[ "$EXPECTED_DIGEST" =~ ^[a-f0-9]{64}$ ]] || { echo 'INVALID_RELEASE_DIGEST' >&2; exit 2; }
ACTUAL_DIGEST="$(/usr/bin/shasum -a 256 "$SOURCE_RELEASE/release.json" | /usr/bin/awk '{print $1}')"
[[ "$ACTUAL_DIGEST" == "$EXPECTED_DIGEST" ]] || { echo 'RELEASE_DIGEST_MISMATCH' >&2; exit 2; }

if /usr/bin/dscl . -read /Users/gram-agent >/dev/null 2>&1; then
  echo 'FOREIGN_GRAM_AGENT_ACCOUNT' >&2
  exit 2
fi
RUNTIME_UID=''
for candidate in {550..599}; do
  if ! /usr/bin/dscl . -search /Users UniqueID "$candidate" | /usr/bin/grep -q .; then
    RUNTIME_UID="$candidate"
    break
  fi
done
[[ -n "$RUNTIME_UID" ]] || { echo 'NO_TEST_UID' >&2; exit 2; }
RUNTIME_GID=20
/usr/bin/dscl . -create /Users/gram-agent
CREATED_USER=1
/usr/bin/dscl . -create /Users/gram-agent UniqueID "$RUNTIME_UID"
/usr/bin/dscl . -create /Users/gram-agent PrimaryGroupID "$RUNTIME_GID"
/usr/bin/dscl . -create /Users/gram-agent NFSHomeDirectory /var/empty
/usr/bin/dscl . -create /Users/gram-agent UserShell /usr/bin/false
/usr/bin/dscl . -create /Users/gram-agent IsHidden 1
[[ "$(/usr/bin/id -u gram-agent)" == "$RUNTIME_UID" ]] || { echo 'ACCOUNT_UID_MISMATCH' >&2; exit 2; }
if /usr/bin/id -G gram-agent | /usr/bin/tr ' ' '\n' | /usr/bin/grep -qx '80'; then
  echo 'ACCOUNT_ADMIN' >&2
  exit 2
fi

RELEASE_ID="$(/usr/bin/plutil -extract releaseId raw -o - "$SOURCE_RELEASE/release.json")"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo 'INVALID_RELEASE_ID' >&2; exit 2; }
DEST_RELEASE="$ROOT/releases/$RELEASE_ID"
/bin/mkdir -p "$ROOT/releases" "$ROOT/config" "$ROOT/bootstrap/bin" "$ROOT/run" "$ROOT/state" "$ROOT/secrets" "$ROOT/logs"
/usr/sbin/chown root:wheel "$VENDOR_ROOT" "$ROOT" "$ROOT/releases" "$ROOT/config" "$ROOT/bootstrap" "$ROOT/bootstrap/bin"
/bin/chmod 0755 "$VENDOR_ROOT" "$ROOT" "$ROOT/releases" "$ROOT/config" "$ROOT/bootstrap" "$ROOT/bootstrap/bin"
/usr/bin/ditto "$SOURCE_RELEASE" "$DEST_RELEASE"
/usr/sbin/chown -R root:wheel "$DEST_RELEASE"
/usr/bin/install -o root -g wheel -m 0755 "$ACL_HELPER" "$ROOT/bootstrap/bin/file-acl"

for dir in "$ROOT/run" "$ROOT/state" "$ROOT/secrets" "$ROOT/logs"; do
  /usr/sbin/chown "$RUNTIME_UID:$RUNTIME_GID" "$dir"
  /bin/chmod 0700 "$dir"
done
printf '%s\n' 'SYNTHETIC_CI_INTERNAL_SECRET' > "$ROOT/secrets/mcp-internal-secret"
/usr/sbin/chown "$RUNTIME_UID:$RUNTIME_GID" "$ROOT/secrets/mcp-internal-secret"
/bin/chmod 0600 "$ROOT/secrets/mcp-internal-secret"

CANDIDATE="$ROOT/config/candidate-service.json"
printf '{"schemaVersion":1,"mode":"LAB_ONLY","runtimeUser":"gram-agent","releaseId":"%s","releaseDigest":"%s","tunnel":{"enabled":false}}' \
  "$RELEASE_ID" "$EXPECTED_DIGEST" > "$CANDIDATE"
/usr/sbin/chown root:wheel "$CANDIDATE"
/bin/chmod 0644 "$CANDIDATE"

NODE="$DEST_RELEASE/bin/node"
OPERATOR="$DEST_RELEASE/packages/macos-lifecycle/dist/operator-cli.js"
[[ -x "$NODE" && -f "$OPERATOR" ]] || { echo 'OPERATOR_MISSING' >&2; exit 2; }

echo 'NATIVE_PHASE=preview'
PREVIEW="$("$NODE" "$OPERATOR" preview --json)"
printf '%s\n' "$PREVIEW" > "${RUNNER_TEMP:-/tmp}/mac02-native-preview.json"
PREVIEW_TOKEN="$("$NODE" -e 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||typeof j.preview.configDigest!=="string") process.exit(2); process.stdout.write(j.preview.configDigest)' "$PREVIEW")"
PREVIOUS="$("$NODE" -e 'const j=JSON.parse(process.argv[1]); if(j.preview?.previousInstallDigest!==null) process.exit(2); process.stdout.write("none")' "$PREVIEW")"

echo 'NATIVE_PHASE=apply'
set +e
APPLY="$("$NODE" "$OPERATOR" apply --config service --expected-config-digest "$PREVIEW_TOKEN" --expected-install-digest "$PREVIOUS" --json)"
APPLY_EXIT=$?
set -e
if [[ "$APPLY_EXIT" -ne 0 ]]; then
  journal_stage='absent'
  if [[ -f "$ROOT/config/install-journal.json" ]]; then
    journal_stage="$("$NODE" -e 'try{const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); const s=j?.stage; process.stdout.write(typeof s==="string"?s:"invalid")}catch{process.stdout.write("invalid")}' "$ROOT/config/install-journal.json")"
  fi
  core_job='absent'
  /bin/launchctl print "system/$CORE_LABEL" >/dev/null 2>&1 && core_job='present'
  tunnel_job='absent'
  /bin/launchctl print "system/$TUNNEL_LABEL" >/dev/null 2>&1 && tunnel_job='present'
  config_present=0; [[ -f "$ROOT/config/service.json" ]] && config_present=1
  manifest_present=0; [[ -f "$ROOT/config/installation.json" ]] && manifest_present=1
  core_plist_present=0; [[ -f "$CORE_PLIST" ]] && core_plist_present=1
  execution_present=0; [[ -f "$ROOT/run/core.execution.json" ]] && execution_present=1
  circuit_present=0; [[ -f "$ROOT/run/core.circuit.json" ]] && circuit_present=1
  db_present=0; [[ -f "$ROOT/state/agent.sqlite" ]] && db_present=1
  echo "NATIVE_OPERATOR_EXIT=$APPLY_EXIT NATIVE_RESULT=$APPLY" >&2
  echo "NATIVE_APPLY_DIAG journal=$journal_stage config=$config_present manifest=$manifest_present core_plist=$core_plist_present core_job=$core_job tunnel_job=$tunnel_job execution=$execution_present circuit=$circuit_present db=$db_present" >&2
  # Read installed review once as the runtime user, without provisioning or
  # starting a session. Force exit at the deadline even if a scan ignores abort.
  if ! /usr/bin/sudo -u gram-agent "$NODE" --input-type=module 2>/dev/null <<'NATIVE_REVIEW_PROBE'
import { constants, writeSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const started = performance.now();
const controller = new AbortController();
let reviewReported = false;
let reviewElapsedMs = -1;
let diagnosticsStarted = -1;
let diagnosticsComplete = false;
const timer = setTimeout(() => {
  controller.abort();
  finish('TIMEOUT', false);
}, 60_000);

function emit(label, fields) {
  writeSync(1, `${label} ${JSON.stringify(fields)}\n`);
}

function reportReview(result, reviewOk) {
  reviewElapsedMs = Math.round(performance.now() - started);
  reviewReported = true;
  emit('NATIVE_REVIEW_DIAG', {
    result, review_ok: reviewOk, elapsed_ms: reviewElapsedMs,
    uid: process.getuid(), gid: process.getgid(), aborted: controller.signal.aborted,
  });
}

function finish(result, reviewOk) {
  clearTimeout(timer);
  try {
    if (!reviewReported) reportReview(result, reviewOk);
    else if (diagnosticsStarted >= 0) emit('NATIVE_REVIEW_DETAIL_DONE', {
      diagnostics_complete: diagnosticsComplete,
      review_elapsed_ms: reviewElapsedMs,
      diag_elapsed_ms: Math.round(performance.now() - diagnosticsStarted),
      aborted: controller.signal.aborted,
    });
  } finally {
    process.exit(0);
  }
}

async function diagnose(source, acl) {
  const fixedRoot = '/Library/Application Support/HAAR/GramAgent';
  // Fixed numeric IDs only: 0-7 are the config chain and its two files;
  // 8-10 extend the shared root chain to the independent bootstrap helper.
  const paths = ['/', '/Library', '/Library/Application Support',
    '/Library/Application Support/HAAR', fixedRoot, `${fixedRoot}/config`,
    `${fixedRoot}/config/service.json`, `${fixedRoot}/config/installation.json`,
    `${fixedRoot}/bootstrap`, `${fixedRoot}/bootstrap/bin`, `${fixedRoot}/bootstrap/bin/file-acl`];
  const isLeaf = id => id === 6 || id === 7 || id === 10;
  const same = (a, b) => ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs']
    .every(key => a[key] === b[key]);

  async function inspectPath(id, probeAcl) {
    const row = { id, stat_ok: false, type: 0, uid: -1, gid: -1, mode: -1, nlink: -1,
      open_ok: false, identity_ok: false, acl_checked: false, acl_ok: false };
    let file;
    try {
      const before = await lstat(paths[id], { bigint: true });
      Object.assign(row, { stat_ok: true, type: before.isDirectory() ? 1 : before.isFile() ? 2 : 0,
        uid: Number(before.uid), gid: Number(before.gid), mode: Number(before.mode & 0o7777n),
        nlink: Number(before.nlink) });
      if (row.type !== (isLeaf(id) ? 2 : 1)) return row;
      file = await open(paths[id], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        | (isLeaf(id) ? 0 : constants.O_DIRECTORY));
      row.open_ok = true;
      row.identity_ok = same(before, await file.stat({ bigint: true }))
        && same(before, await lstat(paths[id], { bigint: true }));
      if (probeAcl && row.identity_ok) {
        row.acl_checked = true;
        row.acl_ok = await acl(file) === true;
      }
      row.identity_ok = row.identity_ok && same(before, await file.stat({ bigint: true }))
        && same(before, await lstat(paths[id], { bigint: true }));
    } catch {
      // The individual false fields are the evidence; never emit error text.
      row.identity_ok = false;
    } finally {
      if (file) await file.close().catch(() => undefined);
    }
    return row;
  }

  let helperFailId = -1;
  for (const id of [1, 2, 3, 4, 8, 9, 10]) {
    const row = await inspectPath(id, false);
    const safe = row.stat_ok && row.open_ok && row.identity_ok && row.uid === 0
      && (row.mode & 0o022) === 0 && row.type === (id === 10 ? 2 : 1)
      && (id !== 10 || row.nlink === 1 && (row.mode & 0o111) !== 0);
    if (!safe && helperFailId === -1) helperFailId = id;
    if (id >= 8) emit('NATIVE_REVIEW_PATH_DIAG', row);
  }
  emit('NATIVE_REVIEW_HELPER_DIAG', {
    helper_chain_checked: true, helper_chain_ok: helperFailId === -1, helper_fail_id: helperFailId,
  });
  for (let id = 0; id <= 7; id++) emit('NATIVE_REVIEW_PATH_DIAG', await inspectPath(id, true));

  const [{ createTrustedFiles }, { parseConfig }, { validateManifestBytes, shaBytes }] = await Promise.all([
    import(new URL('adapters/trusted-files.js', source).href),
    import(new URL('config.js', source).href),
    import(new URL('adapters/install-files.js', source).href),
  ]);
  const files = createTrustedFiles('/', 0, acl, `${fixedRoot.slice(1)}/config`);
  let configBytes = null;
  let manifestBytes = null;
  try { configBytes = await files.read('service.json', 262144); } catch { /* observed below */ }
  try { manifestBytes = await files.read('installation.json', 262144); } catch { /* observed below */ }
  const binding = { config_read_ok: configBytes !== null, manifest_read_ok: manifestBytes !== null,
    config_parse_ok: false, manifest_schema_ok: false, binding_checked: false,
    runtime_name_match: false, runtime_uid_match: false, runtime_gid_match: false,
    config_sha_match: false, release_id_match: false, release_digest_match: false, pre_release_ok: false };
  let config = null;
  if (configBytes !== null) {
    try {
      config = parseConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(configBytes)));
      binding.config_parse_ok = true;
    } catch { /* observed below */ }
  }
  // The production validator checks exact top-level/nested keys, schema 1,
  // COMMITTED state, runtime identity shape and disabled desired state.
  binding.manifest_schema_ok = manifestBytes !== null && validateManifestBytes(manifestBytes);
  if (config !== null && binding.manifest_schema_ok) {
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    binding.binding_checked = true;
    binding.runtime_name_match = manifest.runtime.name === 'gram-agent';
    binding.runtime_uid_match = manifest.runtime.uid === process.getuid();
    binding.runtime_gid_match = manifest.runtime.gid === process.getgid();
    binding.config_sha_match = manifest.configSha256 === shaBytes(configBytes);
    binding.release_id_match = manifest.releaseId === config.releaseId;
    binding.release_digest_match = manifest.releaseDigest === config.releaseDigest;
    binding.pre_release_ok = manifest.schemaVersion === 1 && manifest.state === 'COMMITTED'
      && binding.runtime_name_match && binding.runtime_uid_match && binding.runtime_gid_match
      && binding.config_sha_match && binding.release_id_match && binding.release_digest_match;
  }
  emit('NATIVE_REVIEW_BINDING_DIAG', binding);
}

async function diagnoseRuntime(source, acl, review) {
  const [{ inspectRuntimeDirectories }, { createPrivateRecordFiles },
    { decodeExecution }, { decodeHistory },
    { decodeCoreRegistration, matchesCoreExecution, coreStartIdentity },
    { decodeStatus, parseEvent }, { createTrustedFiles }, { createNativePeerProof }] = await Promise.all([
    import(new URL('adapters/runtime-directories.js', source).href),
    import(new URL('adapters/private-record-files.js', source).href),
    import(new URL('execution-lease.js', source).href),
    import(new URL('lifecycle-store.js', source).href),
    import(new URL('core-registration.js', source).href),
    import(new URL('telemetry.js', source).href),
    import(new URL('adapters/trusted-files.js', source).href),
    import(new URL('adapters/owned-process.js', source).href),
  ]);
  const fixedRoot = '/Library/Application Support/HAAR/GramAgent';
  const directories = await inspectRuntimeDirectories(
    { anchor: '/', relative: fixedRoot.slice(1), ownerUid: 0 },
    process.getuid(), acl, controller.signal,
  );
  emit('NATIVE_RUNTIME_DIR_DIAG', { directories_ok: true });
  const snapshots = new Map();
  for (const kind of ['execution', 'circuit', 'process', 'status', 'events']) {
    if (controller.signal.aborted) return;
    const readStarted = Date.now();
    try {
      await directories.verify();
      const policy = kind === 'events' ? directories.logsPolicy : directories.runPolicy;
      // Only the existing fixed-family read API is used. No CAS, initialization,
      // recovery, session, credential or HTTP operation is performed.
      const bytes = await createPrivateRecordFiles(kind, policy).read('core');
      await directories.verify();
      const readFinished = Date.now();
      snapshots.set(kind, { bytes, readStarted, readFinished });
      emit('NATIVE_RUNTIME_READ_DIAG', {
        kind, read_ok: true, present: bytes.some(value => value !== null),
        elapsed_ms: Math.max(0, readFinished - readStarted),
      });
    } catch {
      emit('NATIVE_RUNTIME_READ_DIAG', {
        kind, read_ok: false, present: false, elapsed_ms: Math.max(0, Date.now() - readStarted),
      });
    }
  }
  const first = kind => snapshots.get(kind)?.bytes[0] ?? null;
  const held = first('execution') === null ? null : decodeExecution(first('execution'));
  const history = first('circuit') === null ? null : decodeHistory(first('circuit'));
  const registration = first('process') === null ? null : decodeCoreRegistration(first('process'));
  const status = first('status') === null ? null : decodeStatus(first('status'));
  const statusRead = snapshots.get('status');
  const sameReview = value => value !== null && value.releaseDigest === review.config.releaseDigest;
  const matched = held !== null && registration !== null && matchesCoreExecution(registration, held);
  emit('NATIVE_RUNTIME_RECORD_DIAG', {
    execution_state: held?.state ?? 'UNAVAILABLE', execution_revision: held?.revision ?? -1,
    execution_config_match: held?.configDigest === review.configDigest,
    execution_release_match: sameReview(held),
    circuit_blocked: history?.blocked ?? null, circuit_active: history?.activeAttempt !== null && history !== null,
    circuit_exit_count: history?.exitsMs.length ?? -1,
    registration_present: registration !== null, registration_execution_match: matched,
    registration_config_match: registration?.configDigest === review.configDigest,
    registration_release_match: sameReview(registration?.child ?? null),
    status_state: status?.state ?? 'UNAVAILABLE', status_code: status?.code ?? 'UNAVAILABLE',
    status_attempt: status?.attemptCount ?? -1,
    status_age_ms: status === null ? -1 : statusRead.readFinished - status.observedAtMs,
    status_after_read_start: status !== null && status.observedAtMs > statusRead.readStarted,
    status_after_read_end: status !== null && status.observedAtMs > statusRead.readFinished,
    status_execution_generation_match: status !== null && status.generation === held?.generation,
    status_registration_generation_match: status !== null && status.generation === registration?.child.generation,
    status_release_match: sameReview(status),
  });
  const generation = registration?.child.generation ?? held?.generation ?? history?.lastGeneration;
  const events = [];
  for (const bytes of snapshots.get('events')?.bytes ?? []) {
    if (bytes === null) continue;
    // The fixed record adapter already validated every canonical segment line.
    for (const line of bytes.toString('utf8').split('\n').slice(1, -1)) {
      const event = parseEvent(JSON.parse(line));
      if (event.generation === generation && sameReview(event)) events.push(event);
    }
  }
  events.sort((a, b) => a.observedAtMs - b.observedAtMs);
  emit('NATIVE_RUNTIME_EVENT_DIAG', {
    matching_event_count: events.length,
    recent: events.slice(-16).map(event => ({
      code: event.code, attempt: event.attemptCount, age_ms: Date.now() - event.observedAtMs,
    })),
  });
  if (registration === null || controller.signal.aborted) return;
  const releasePrefix = `${fixedRoot.slice(1)}/releases/${review.config.releaseId}`;
  const releaseFiles = createTrustedFiles('/', 0, acl, releasePrefix);
  const nodePath = `${fixedRoot}/releases/${review.config.releaseId}/bin/node`;
  const helperPath = `${fixedRoot}/releases/${review.config.releaseId}/bin/peer-owner`;
  const node = await lstat(nodePath, { bigint: true });
  const observerNode = await lstat(nodePath);
  const pinsOk = node.isFile() && node.uid === 0n && node.nlink === 1n
    && (node.mode & 0o6022n) === 0n && (node.mode & 0o111n) !== 0n
    && await releaseFiles.hash('bin/node', 256 * 1024 * 1024) === review.nodeDigest
    && await releaseFiles.hash('bin/peer-owner', 256 * 1024 * 1024) === review.peerOwnerDigest;
  let verdict = 'UNAVAILABLE';
  if (pinsOk && !controller.signal.aborted) {
    const start = coreStartIdentity(registration.child.startIdentity);
    verdict = await createNativePeerProof(helperPath).current({
      pid: registration.child.pid, uid: registration.child.uid,
      startSec: start.sec, startUsec: start.usec, executable: { dev: node.dev, ino: node.ino },
    }, controller.signal);
  }
  // This is a post-compensation process observation. It does not recreate the
  // supervisor's protected proof call or establish authenticated Core health.
  emit('NATIVE_RUNTIME_PROCESS_DIAG', {
    pins_ok: pinsOk, verdict, aborted: controller.signal.aborted,
    observer_inode_safe_integer: Number.isSafeInteger(observerNode.ino),
    observer_numeric_identity_exact: BigInt(observerNode.ino) === node.ino && BigInt(observerNode.dev) === node.dev,
  });
}

try {
  const source = new URL('../packages/macos-lifecycle/dist/a-system-sources.js', pathToFileURL(process.execPath));
  const { createSystemBootstrapSources } = await import(source.href);
  const sources = createSystemBootstrapSources();
  const review = await sources.review.read(controller.signal);
  reportReview(review === null ? 'REFUSED' : 'READY', review !== null);
  if (!controller.signal.aborted) {
    diagnosticsStarted = performance.now();
    try {
      if (review === null) await diagnose(source, sources.acl);
      else await diagnoseRuntime(source, sources.acl, review);
      diagnosticsComplete = true;
    } catch { /* Preserve the review result; report incomplete diagnostics. */ }
  }
  finish(review === null ? 'REFUSED' : 'READY', review !== null);
} catch {
  finish('ERROR', false);
}
NATIVE_REVIEW_PROBE
  then
    echo 'NATIVE_REVIEW_DIAG {"result":"ERROR","review_ok":false,"elapsed_ms":0,"uid":null,"gid":null,"aborted":false}' >&2
  fi
  exit 2
fi
if ! "$NODE" -e 'const j=JSON.parse(process.argv[1]); if(j.result?.ok!==true||j.result?.code!=="OK") process.exit(2)' "$APPLY"; then echo "NATIVE_RESULT=$APPLY" >&2; exit 2; fi

# B1 apply proves launchd start + owned authenticated Core health internally,
# then parks the LAB_ONLY installation stopped/disabled before COMMITTED.
if /bin/launchctl print "system/$CORE_LABEL" >/dev/null 2>&1; then
  echo 'CORE_NOT_PARKED' >&2
  exit 2
fi
[[ -f "$ROOT/config/service.json" && -f "$ROOT/config/installation.json" && -f "$ROOT/config/install-journal.json" && -f "$CORE_PLIST" ]] \
  || { echo 'COMMITTED_FILES_MISSING' >&2; exit 2; }
for file in "$ROOT/config/service.json" "$ROOT/config/installation.json" "$ROOT/config/install-journal.json" "$CORE_PLIST"; do
  [[ "$(/usr/bin/stat -f '%u' "$file")" == '0' && "$(/usr/bin/stat -f '%Lp' "$file")" == '644' ]] \
    || { echo 'COMMITTED_FILE_MODE_INVALID' >&2; exit 2; }
done

POST="$("$NODE" "$OPERATOR" preview --json)"
"$NODE" -e 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||typeof j.preview.previousInstallDigest!=="string"||j.preview.previousInstallDigest.length!==64) process.exit(2)' "$POST"
POST_TOKEN="$("$NODE" -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.configDigest)' "$POST")"
POST_INSTALL="$("$NODE" -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.previousInstallDigest)' "$POST")"

echo 'NATIVE_PHASE=start'
set +e
START="$("$NODE" "$OPERATOR" start --config service --expected-config-digest "$POST_TOKEN" --expected-install-digest "$POST_INSTALL" --json)"
START_EXIT=$?
set -e
if [[ "$START_EXIT" -ne 0 ]]; then
  echo "NATIVE_OPERATOR_EXIT=$START_EXIT NATIVE_RESULT=$START" >&2
  exit 2
fi
if ! "$NODE" -e 'const j=JSON.parse(process.argv[1]); if(j.result?.ok!==true||j.result?.code!=="OK") process.exit(2)' "$START"; then echo "NATIVE_RESULT=$START" >&2; exit 2; fi
/bin/launchctl print "system/$CORE_LABEL" >/dev/null 2>&1 || { echo 'CORE_START_NOT_REGISTERED' >&2; exit 2; }
for _ in {1..50}; do
  if /usr/bin/curl -fsS --max-time 1 http://127.0.0.1:3847/healthz >/dev/null; then break; fi
  sleep 0.1
done
/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:3847/healthz >/dev/null || { echo 'CORE_START_NOT_HEALTHY' >&2; exit 2; }

echo 'NATIVE_PHASE=restart'
set +e
RESTART="$("$NODE" "$OPERATOR" restart --config service --expected-config-digest "$POST_TOKEN" --expected-install-digest "$POST_INSTALL" --json)"
RESTART_EXIT=$?
set -e
if [[ "$RESTART_EXIT" -ne 0 ]]; then
  echo "NATIVE_OPERATOR_EXIT=$RESTART_EXIT NATIVE_RESULT=$RESTART" >&2
  exit 2
fi
if ! "$NODE" -e 'const j=JSON.parse(process.argv[1]); if(j.result?.ok!==true||j.result?.code!=="OK") process.exit(2)' "$RESTART"; then echo "NATIVE_RESULT=$RESTART" >&2; exit 2; fi
/bin/launchctl print "system/$CORE_LABEL" >/dev/null 2>&1 || { echo 'CORE_RESTART_NOT_REGISTERED' >&2; exit 2; }
/usr/bin/curl -fsS --max-time 2 http://127.0.0.1:3847/healthz >/dev/null || { echo 'CORE_RESTART_NOT_HEALTHY' >&2; exit 2; }

echo 'NATIVE_PHASE=stop'
set +e
STOP="$("$NODE" "$OPERATOR" stop --config service --expected-config-digest "$POST_TOKEN" --expected-install-digest "$POST_INSTALL" --json)"
STOP_EXIT=$?
set -e
if [[ "$STOP_EXIT" -ne 0 ]]; then
  echo "NATIVE_OPERATOR_EXIT=$STOP_EXIT NATIVE_RESULT=$STOP" >&2
  exit 2
fi
if ! "$NODE" -e 'const j=JSON.parse(process.argv[1]); if(j.result?.ok!==true||j.result?.code!=="OK") process.exit(2)' "$STOP"; then echo "NATIVE_RESULT=$STOP" >&2; exit 2; fi
if /bin/launchctl print "system/$CORE_LABEL" >/dev/null 2>&1; then
  echo 'CORE_STOP_NOT_PARKED' >&2
  exit 2
fi

STOPPED="$("$NODE" "$OPERATOR" preview --json)"
"$NODE" -e 'const a=JSON.parse(process.argv[1]); const b=JSON.parse(process.argv[2]); if(!a.preview?.ok||a.preview.configDigest!==b.preview.configDigest||a.preview.previousInstallDigest!==b.preview.previousInstallDigest) process.exit(2)' "$STOPPED" "$POST"
POST_TOKEN="$("$NODE" -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.configDigest)' "$STOPPED")"
POST_INSTALL="$("$NODE" -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.previousInstallDigest)' "$STOPPED")"

echo 'NATIVE_PHASE=uninstall'
set +e
UNINSTALL="$("$NODE" "$OPERATOR" uninstall --config service --expected-config-digest "$POST_TOKEN" --expected-install-digest "$POST_INSTALL" --json)"
UNINSTALL_EXIT=$?
set -e
if [[ "$UNINSTALL_EXIT" -ne 0 ]]; then
  echo "NATIVE_OPERATOR_EXIT=$UNINSTALL_EXIT NATIVE_RESULT=$UNINSTALL" >&2
  exit 2
fi
if ! "$NODE" -e 'const j=JSON.parse(process.argv[1]); if(j.result?.ok!==true||j.result?.code!=="OK") process.exit(2)' "$UNINSTALL"; then echo "NATIVE_RESULT=$UNINSTALL" >&2; exit 2; fi

for removed in "$ROOT/config/service.json" "$ROOT/config/installation.json" "$ROOT/config/install-journal.json" "$CORE_PLIST"; do
  [[ ! -e "$removed" ]] || { echo "UNINSTALL_RESIDUAL=$removed" >&2; exit 2; }
done
for preserved in "$ROOT/releases/$RELEASE_ID" "$ROOT/run" "$ROOT/state" "$ROOT/secrets" "$ROOT/logs"; do
  [[ -e "$preserved" ]] || { echo "UNINSTALL_OVERDELETE=$preserved" >&2; exit 2; }
done
disabled_output="$(/bin/launchctl print-disabled system)"
core_override="$(/usr/bin/grep -F "\"$CORE_LABEL\"" <<<"$disabled_output" | /usr/bin/head -n 1 || true)"
[[ "$core_override" == *'=> false'* || "$core_override" == *'=> enabled'* ]] || {
  echo "UNINSTALL_OVERRIDE_NOT_NEUTRAL=$core_override" >&2
  exit 2
}

EMPTY="$("$NODE" "$OPERATOR" preview --json)"
"$NODE" -e 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||j.preview.previousInstallDigest!==null) process.exit(2)' "$EMPTY"
EMPTY_TOKEN="$("$NODE" -e 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.configDigest)' "$EMPTY")"
echo 'NATIVE_PHASE=second-uninstall'
set +e
SECOND="$("$NODE" "$OPERATOR" uninstall --config service --expected-config-digest "$EMPTY_TOKEN" --expected-install-digest none --json)"
SECOND_EXIT=$?
set -e
if [[ "$SECOND_EXIT" -ne 0 ]]; then
  echo "NATIVE_OPERATOR_EXIT=$SECOND_EXIT NATIVE_RESULT=$SECOND" >&2
  exit 2
fi
if ! "$NODE" -e 'const j=JSON.parse(process.argv[1]); if(j.result?.ok!==true||j.result?.code!=="OK") process.exit(2)' "$SECOND"; then echo "NATIVE_RESULT=$SECOND" >&2; exit 2; fi

echo "DISPOSABLE_LAUNCHD_APPLY_UNINSTALL_PASS release_id=$RELEASE_ID release_digest=$EXPECTED_DIGEST runtime_uid=$RUNTIME_UID"
