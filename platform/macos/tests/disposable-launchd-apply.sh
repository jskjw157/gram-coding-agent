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
ROOT='/Library/Application Support/HAAR/GramAgent'
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
/usr/sbin/chown root:wheel "$ROOT" "$ROOT/releases" "$ROOT/config" "$ROOT/bootstrap" "$ROOT/bootstrap/bin"
/bin/chmod 0755 "$ROOT" "$ROOT/releases" "$ROOT/config" "$ROOT/bootstrap" "$ROOT/bootstrap/bin"
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

PREVIEW="$(${NODE@Q} ${OPERATOR@Q} preview --json)"
printf '%s\n' "$PREVIEW" > "${RUNNER_TEMP:-/tmp}/mac02-native-preview.json"
PREVIEW_TOKEN="$($NODE -e 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||typeof j.preview.configDigest!=="string") process.exit(2); process.stdout.write(j.preview.configDigest)' "$PREVIEW")"
PREVIOUS="$($NODE -e 'const j=JSON.parse(process.argv[1]); if(j.preview?.previousInstallDigest!==null) process.exit(2); process.stdout.write("none")' "$PREVIEW")"

APPLY="$($NODE "$OPERATOR" apply --config service --expected-config-digest "$PREVIEW_TOKEN" --expected-install-digest "$PREVIOUS" --json)"
$NODE -e 'const j=JSON.parse(process.argv[1]); if(j.result?.ok!==true||j.result?.code!=="OK") process.exit(2)' "$APPLY"

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

POST="$($NODE "$OPERATOR" preview --json)"
$NODE -e 'const j=JSON.parse(process.argv[1]); if(!j.preview?.ok||typeof j.preview.previousInstallDigest!=="string"||j.preview.previousInstallDigest.length!==64) process.exit(2)' "$POST"

echo "DISPOSABLE_LAUNCHD_APPLY_PASS release_id=$RELEASE_ID release_digest=$EXPECTED_DIGEST runtime_uid=$RUNTIME_UID"
