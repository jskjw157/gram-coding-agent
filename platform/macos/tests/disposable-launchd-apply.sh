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
SCRIPT_DIR="$(cd "$(dirname "$0")" && /bin/pwd -P)"
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

runtime_snapshot() {
  # Failure-only, unchanged read-only diagnostic previously embedded at apply.
  # Stdin keeps the observation code readable in the synthetic runtime account.
  if ! /usr/bin/sudo -u gram-agent "$NODE" --input-type=module \
    2>/dev/null < "$SCRIPT_DIR/native-runtime-snapshot.mjs"; then
    echo 'NATIVE_REVIEW_DIAG {"result":"ERROR","review_ok":false,"elapsed_ms":0,"uid":null,"gid":null,"aborted":false}' >&2
  fi
}

preview_snapshot() {
  # Failure-only observation. Never retry the preview or change its result.
  if ! "$NODE" --input-type=module - "$1" "$2" 2>/dev/null <<'NATIVE_PREVIEW_SNAPSHOT'
import { execFile } from 'node:child_process';
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const phases = { initial: 'INITIAL', 'post-apply': 'POST_APPLY',
  'post-stop': 'POST_STOP', 'post-uninstall': 'POST_UNINSTALL', restart: 'RESTART' };
const failures = { preview: 'PREVIEW', assertion: 'ASSERTION' };
const phase = Object.hasOwn(phases, process.argv[2]) ? phases[process.argv[2]] : null;
const failure = Object.hasOwn(failures, process.argv[3]) ? failures[process.argv[3]] : null;
const prefix = phase !== null && failure !== null ? phase + '_' + failure : null;
const stage = prefix === null ? null : {
  done: prefix + '_DONE', timeout: prefix + '_TIMEOUT', error: prefix + '_ERROR',
};
const snapshot = {
  ports: { core: 'unknown', tunnel: 'unknown' },
  tcp_states: { core: [], tunnel: [] },
  registry: null,
};
let finished = false;
let timer;
function finish(kind) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  try {
    writeSync(1, 'NATIVE_PREVIEW_SYSTEM_DIAG ' + JSON.stringify({
      stage: stage?.[kind] ?? 'UNKNOWN_ERROR', ...snapshot,
    }) + '\n');
  } finally {
    process.exit(0);
  }
}
// One hard deadline covers imports and both read-only observations.
timer = setTimeout(() => finish('timeout'), 10_000);

function netstat() {
  return new Promise(resolve => {
    execFile('/usr/sbin/netstat', ['-anl', '-p', 'tcp'], {
      encoding: 'utf8', timeout: 2_000, killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024, shell: false,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', LANG: 'C' },
    }, (error, stdout, stderr) => {
      const rawCode = error?.code;
      const code = error === null ? 0
        : error?.killed !== true && error?.signal == null && typeof rawCode === 'number'
          && Number.isSafeInteger(rawCode) && rawCode >= 1 && rawCode <= 255 ? rawCode : 255;
      resolve({ code, stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : '' });
    });
  });
}

try {
  if (stage === null) finish('error');
  const source = new URL('../packages/macos-lifecycle/dist/adapters/macos-service-probes.js',
    pathToFileURL(process.execPath));
  const { inspectMacRegistry, parseTcpSnapshot } = await import(source.href);
  const results = await Promise.allSettled([
    (async () => {
      const value = await inspectMacRegistry();
      const roles = ['core', 'tunnel'];
      if (value !== null && roles.every(role =>
        ['absent', 'present'].includes(value?.jobs?.[role])
        && (value?.overrides?.[role] === null || typeof value?.overrides?.[role] === 'boolean'))) {
        snapshot.registry = {
          jobs: { core: value.jobs.core, tunnel: value.jobs.tunnel },
          overrides: { core: value.overrides.core, tunnel: value.overrides.tunnel },
        };
      }
    })(),
    (async () => {
      const raw = await netstat();
      const ports = parseTcpSnapshot(raw);
      snapshot.ports = { core: ports.core, tunnel: ports.tunnel };
      // Decode target-port states only after the production parser accepts
      // the complete table. Never emit native text, addresses, or PIDs.
      if (ports.core === 'unknown' || ports.tunnel === 'unknown') return;
      const recognized = new Set(['CLOSED', 'LISTEN', 'SYN_SENT', 'SYN_RECEIVED',
        'ESTABLISHED', 'CLOSE_WAIT', 'FIN_WAIT_1', 'CLOSING', 'LAST_ACK', 'FIN_WAIT_2', 'TIME_WAIT']);
      const found = { core: new Set(), tunnel: new Set() };
      for (const line of raw.stdout.split('\n').map(value => value.trim()).filter(Boolean).slice(2)) {
        const fields = line.split(/[ \t]+/u);
        const endpoint = fields[3];
        const port = Number(endpoint.slice(endpoint.lastIndexOf('.') + 1));
        const role = port === 3847 ? 'core' : port === 8080 ? 'tunnel' : null;
        if (role !== null && recognized.has(fields[5])) found[role].add(fields[5]);
      }
      snapshot.tcp_states = { core: [...found.core].sort(), tunnel: [...found.tunnel].sort() };
    })(),
  ]);
  finish(results.every(result => result.status === 'fulfilled') ? 'done' : 'error');
} catch {
  finish('error');
}
NATIVE_PREVIEW_SNAPSHOT
  then
    echo 'NATIVE_PREVIEW_SYSTEM_DIAG {"stage":"PROCESS_ERROR","ports":{"core":"unknown","tunnel":"unknown"},"tcp_states":{"core":[],"tunnel":[]},"registry":null}'
  fi
}

preview_summary() {
  if ! "$NODE" --input-type=module - "$1" "$2" "$3" "$4" "$5" 2>/dev/null <<'NATIVE_PREVIEW_SUMMARY'
const codes = new Set(['OK', 'UNSUPPORTED_HOST', 'INVALID_CONFIG', 'ACCOUNT_INVALID',
  'UNTRUSTED_RELEASE', 'UNSAFE_PATH', 'FOREIGN_SERVICE', 'PORT_IN_USE', 'CONFIG_CHANGED',
  'BUSY', 'AUTH_BLOCKED', 'HEALTH_UNKNOWN', 'TOOL_SURFACE_MISMATCH', 'RESTART_BUDGET',
  'INVALID_HISTORY', 'ROLLBACK_BLOCKED_SCHEMA', 'PARTIAL_INSTALL', 'NOT_AUTHORIZED',
  'TUNNEL_COMPATIBILITY_REQUIRED', 'INTERNAL_ERROR']);
function preview(value) {
  try {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 65_536) return null;
    const parsed = JSON.parse(value)?.preview;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
const phases = { initial: 'INITIAL', 'post-apply': 'POST_APPLY',
  'post-stop': 'POST_STOP', 'post-uninstall': 'POST_UNINSTALL', restart: 'RESTART' };
const phase = Object.hasOwn(phases, process.argv[2]) ? phases[process.argv[2]] : 'UNKNOWN';
const current = preview(process.argv[4]);
const prior = preview(process.argv[6]);
const comparisonPresent = phase === 'POST_STOP' && process.argv[5] === 'true';
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const exit = Number(process.argv[3]);
process.stdout.write('NATIVE_PREVIEW_DIAG ' + JSON.stringify({
  phase,
  exit: Number.isSafeInteger(exit) && exit >= 0 && exit <= 255 ? exit : null,
  preview_ok: current?.ok === true,
  preview_code: codes.has(current?.code) ? current.code : 'UNKNOWN',
  config_digest_valid: digest(current?.configDigest),
  install_digest_valid: current !== null && (current.previousInstallDigest === null
    || digest(current.previousInstallDigest)),
  comparison_present: comparisonPresent,
  config_token_match: comparisonPresent
    ? digest(current?.configDigest) && current.configDigest === prior?.configDigest : null,
  install_digest_match: comparisonPresent ? digest(current?.previousInstallDigest)
    && current.previousInstallDigest === prior?.previousInstallDigest : null,
}) + '\n');
NATIVE_PREVIEW_SUMMARY
  then
    printf 'NATIVE_PREVIEW_DIAG {"phase":"UNKNOWN","exit":%d,"preview_ok":false,"preview_code":"UNKNOWN","config_digest_valid":false,"install_digest_valid":false,"comparison_present":%s,"config_token_match":null,"install_digest_match":null}\n' "$2" "$4"
  fi
}

run_preview() {
  local phase="$1"
  local comparison_present=false
  local comparison=''
  case "$phase" in
    initial) echo 'NATIVE_PHASE=preview' ;;
    post-apply) echo 'NATIVE_PHASE=post-apply-preview' ;;
    post-stop)
      echo 'NATIVE_PHASE=post-stop-preview'
      comparison_present=true
      comparison="$2"
      ;;
    post-uninstall) echo 'NATIVE_PHASE=post-uninstall-preview' ;;
    *) return 64 ;;
  esac
  if [[ "$phase" != initial ]]; then
    # B1 parks the owned job before these checkpoints. Its authenticated health
    # connection may leave TIME_WAIT. Observe complete idleness before the one
    # preview attempt; do not weaken production occupancy checks or retry preview.
    "$NODE" --input-type=module - "$SCRIPT_DIR/wait-for-idle-ports.mjs" <<'NATIVE_IDLE_PORTS'
import { pathToFileURL } from 'node:url';
const { waitForIdlePorts } = await import(pathToFileURL(process.argv[2]).href);
const source = new URL('../packages/macos-lifecycle/dist/adapters/macos-service-probes.js',
  pathToFileURL(process.execPath));
const { inspectMacPorts } = await import(source.href);
await waitForIdlePorts(inspectMacPorts);
console.log('NATIVE_FIXTURE_PORTS_IDLE');
NATIVE_IDLE_PORTS
  fi
  set +e
  CAPTURED_PREVIEW="$("$NODE" "$OPERATOR" preview --json)"
  local preview_exit=$?
  set -e
  preview_summary "$phase" "$preview_exit" "$CAPTURED_PREVIEW" "$comparison_present" "$comparison"
  if [[ "$preview_exit" -ne 0 ]]; then
    preview_snapshot "$phase" preview >&2
    return "$preview_exit"
  fi
  return 0
}

preview_assert() {
  local phase="$1"
  local assertion="$2"
  shift 2
  set +e
  "$NODE" -e "$assertion" "$@"
  local assertion_exit=$?
  set -e
  if [[ "$assertion_exit" -ne 0 ]]; then
    # Token assertions run in command substitutions; keep their diagnostics
    # visible without mixing them into captured token output.
    preview_snapshot "$phase" assertion >&2
    return "$assertion_exit"
  fi
  return 0
}

run_preview initial
PREVIEW="$CAPTURED_PREVIEW"
printf '%s\n' "$PREVIEW" > "${RUNNER_TEMP:-/tmp}/mac02-native-preview.json"
PREVIEW_TOKEN="$(preview_assert initial 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||typeof j.preview.configDigest!=="string") process.exit(2); process.stdout.write(j.preview.configDigest)' "$PREVIEW")"
PREVIOUS="$(preview_assert initial 'const j=JSON.parse(process.argv[1]); if(j.preview?.previousInstallDigest!==null) process.exit(2); process.stdout.write("none")' "$PREVIEW")"

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
  runtime_snapshot
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

run_preview post-apply
POST="$CAPTURED_PREVIEW"
preview_assert post-apply 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||typeof j.preview.previousInstallDigest!=="string"||j.preview.previousInstallDigest.length!==64) process.exit(2)' "$POST"
POST_TOKEN="$(preview_assert post-apply 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.configDigest)' "$POST")"
POST_INSTALL="$(preview_assert post-apply 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.previousInstallDigest)' "$POST")"

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
  preview_snapshot restart preview >&2
  runtime_snapshot
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

run_preview post-stop "$POST"
STOPPED="$CAPTURED_PREVIEW"
preview_assert post-stop 'const a=JSON.parse(process.argv[1]); const b=JSON.parse(process.argv[2]); if(!a.preview?.ok||a.preview.configDigest!==b.preview.configDigest||a.preview.previousInstallDigest!==b.preview.previousInstallDigest) process.exit(2)' "$STOPPED" "$POST"
POST_TOKEN="$(preview_assert post-stop 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.configDigest)' "$STOPPED")"
POST_INSTALL="$(preview_assert post-stop 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.previousInstallDigest)' "$STOPPED")"

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

run_preview post-uninstall
EMPTY="$CAPTURED_PREVIEW"
preview_assert post-uninstall 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||j.preview.previousInstallDigest!==null) process.exit(2)' "$EMPTY"
EMPTY_TOKEN="$(preview_assert post-uninstall 'const j=JSON.parse(process.argv[1]); process.stdout.write(j.preview.configDigest)' "$EMPTY")"
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
