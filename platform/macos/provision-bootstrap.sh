#!/bin/bash
set -euo pipefail
umask 077

ROOT='/Library/Application Support/HAAR/GramAgent'
BOOTSTRAP_DIR="$ROOT/bootstrap/bin"
HELPER="$BOOTSTRAP_DIR/file-acl"
CONFIG_DIR="$ROOT/config"
RELEASES_DIR="$ROOT/releases"
RUN_DIR="$ROOT/run"
STATE_DIR="$ROOT/state"
SECRET_DIR="$ROOT/secrets"
LOG_DIR="$ROOT/logs"
SECRET_FILE="$SECRET_DIR/mcp-internal-secret"
RUNTIME_USER='gram-agent'
SCRIPT_DIR="$(cd "$(dirname "$0")" && /bin/pwd -P)"
BUILDER="$SCRIPT_DIR/build-bootstrap-helper.sh"

mode="${1:---check}"
if [[ "$mode" != "--check" && "$mode" != "--apply" ]]; then
  echo "usage: provision-bootstrap.sh [--check|--apply]" >&2
  exit 64
fi

account_ids() {
  local uid gid
  uid="$(/usr/bin/id -u "$RUNTIME_USER" 2>/dev/null)" || return 1
  gid="$(/usr/bin/id -g "$RUNTIME_USER" 2>/dev/null)" || return 1
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ && "$uid" -gt 0 ]] || return 1
  if /usr/bin/id -G "$RUNTIME_USER" | /usr/bin/tr ' ' '\n' | /usr/bin/grep -qx '80'; then
    return 1
  fi
  printf '%s %s\n' "$uid" "$gid"
}

check_fixed_file() {
  local path="$1" uid="$2" mode="$3"
  [[ -f "$path" && ! -L "$path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$path")" == "$uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$path")" == "$mode" ]] || return 1
}

check_fixed_dir() {
  local path="$1" uid="$2" mode="$3"
  [[ -d "$path" && ! -L "$path" ]] || return 1
  [[ "$(/usr/bin/stat -f '%u' "$path")" == "$uid" ]] || return 1
  [[ "$(/usr/bin/stat -f '%Lp' "$path")" == "$mode" ]] || return 1
}

read -r RUNTIME_UID RUNTIME_GID < <(account_ids) || {
  echo "BOOTSTRAP_NOT_READY account=$RUNTIME_USER" >&2
  exit 2
}

if [[ "$mode" == "--check" ]]; then
  check_fixed_dir "$BOOTSTRAP_DIR" 0 755 \
    && check_fixed_file "$HELPER" 0 755 \
    && check_fixed_dir "$CONFIG_DIR" 0 755 \
    && check_fixed_dir "$RELEASES_DIR" 0 755 \
    && check_fixed_dir "$RUN_DIR" "$RUNTIME_UID" 700 \
    && check_fixed_dir "$STATE_DIR" "$RUNTIME_UID" 700 \
    && check_fixed_dir "$SECRET_DIR" "$RUNTIME_UID" 700 \
    && check_fixed_dir "$LOG_DIR" "$RUNTIME_UID" 700 \
    && check_fixed_file "$SECRET_FILE" "$RUNTIME_UID" 600 \
    || { echo "BOOTSTRAP_NOT_READY" >&2; exit 2; }
  echo "BOOTSTRAP_READY"
  exit 0
fi

[[ "${EUID:-$(/usr/bin/id -u)}" -eq 0 ]] || {
  echo "NOT_AUTHORIZED" >&2
  exit 77
}
[[ -f "$BUILDER" && ! -L "$BUILDER" ]] || { echo "BUILDER_UNAVAILABLE" >&2; exit 2; }

TMP="$(/usr/bin/mktemp -d "${TMPDIR:-/var/tmp}/gram-bootstrap.XXXXXX")"
trap '/bin/rm -rf "$TMP"' EXIT
/bin/bash "$BUILDER" "$TMP/file-acl" >/dev/null

/bin/mkdir -p "$BOOTSTRAP_DIR" "$CONFIG_DIR" "$RELEASES_DIR" "$RUN_DIR" "$STATE_DIR" "$SECRET_DIR" "$LOG_DIR"
/usr/sbin/chown root:wheel "$ROOT" "$ROOT/bootstrap" "$BOOTSTRAP_DIR" "$CONFIG_DIR" "$RELEASES_DIR"
/bin/chmod 0755 "$ROOT" "$ROOT/bootstrap" "$BOOTSTRAP_DIR" "$CONFIG_DIR" "$RELEASES_DIR"

/usr/sbin/chown "$RUNTIME_UID:$RUNTIME_GID" "$RUN_DIR" "$STATE_DIR" "$SECRET_DIR" "$LOG_DIR"
/bin/chmod 0700 "$RUN_DIR" "$STATE_DIR" "$SECRET_DIR" "$LOG_DIR"

/usr/bin/install -o root -g wheel -m 0755 "$TMP/file-acl" "$HELPER"

if [[ ! -e "$SECRET_FILE" ]]; then
  [[ -x /usr/bin/openssl ]] || { echo "OPENSSL_UNAVAILABLE" >&2; exit 2; }
  /usr/bin/openssl rand -hex 32 > "$TMP/mcp-internal-secret"
  /usr/bin/install -o "$RUNTIME_UID" -g "$RUNTIME_GID" -m 0600 \
    "$TMP/mcp-internal-secret" "$SECRET_FILE"
fi

check_fixed_file "$HELPER" 0 755 \
  && check_fixed_dir "$CONFIG_DIR" 0 755 \
  && check_fixed_dir "$RELEASES_DIR" 0 755 \
  && check_fixed_dir "$RUN_DIR" "$RUNTIME_UID" 700 \
  && check_fixed_dir "$STATE_DIR" "$RUNTIME_UID" 700 \
  && check_fixed_dir "$SECRET_DIR" "$RUNTIME_UID" 700 \
  && check_fixed_dir "$LOG_DIR" "$RUNTIME_UID" 700 \
  && check_fixed_file "$SECRET_FILE" "$RUNTIME_UID" 600 \
  || { echo "BOOTSTRAP_PROVISION_FAILED" >&2; exit 2; }

echo "BOOTSTRAP_PROVISIONED"
