#!/bin/bash
set -euo pipefail
umask 077

if [[ $# -ne 2 || "$2" != /* ]]; then
  echo 'usage: assemble-core-release.sh <release-id> /absolute/output-dir' >&2
  exit 64
fi
if [[ "$(/usr/bin/uname -s)" != 'Darwin' || "$(/usr/bin/uname -m)" != 'arm64' ]]; then
  echo 'UNSUPPORTED_HOST' >&2
  exit 2
fi
if [[ "${EUID:-$(/usr/bin/id -u)}" -eq 0 ]]; then
  echo 'BUILD_AS_ROOT_FORBIDDEN' >&2
  exit 77
fi

RELEASE_ID="$1"
DEST="$2"
SCRIPT_DIR="$(cd "$(dirname "$0")" && /bin/pwd -P)"
REPO="$(cd "$SCRIPT_DIR/../.." && /bin/pwd -P)"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || { echo 'INVALID_RELEASE_ID' >&2; exit 2; }
[[ ! -e "$DEST" ]] || { echo 'OUTPUT_EXISTS' >&2; exit 2; }

NODE_BIN="$(command -v node)"
PNPM_BIN="$(command -v pnpm)"
[[ -x "$NODE_BIN" && -x "$PNPM_BIN" ]] || { echo 'BUILD_TOOL_UNAVAILABLE' >&2; exit 2; }
[[ "$($NODE_BIN -p 'process.platform')" == 'darwin' ]] || { echo 'WRONG_NODE_PLATFORM' >&2; exit 2; }
[[ "$($NODE_BIN -p 'process.arch')" == 'arm64' ]] || { echo 'WRONG_NODE_ARCH' >&2; exit 2; }
[[ "$($NODE_BIN -p 'process.versions.node.split(`.`)[0]')" == '24' ]] || { echo 'WRONG_NODE_MAJOR' >&2; exit 2; }

SOURCE_COMMIT="$(/usr/bin/git -C "$REPO" rev-parse HEAD)"
[[ "$SOURCE_COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo 'INVALID_SOURCE_COMMIT' >&2; exit 2; }
/usr/bin/git -C "$REPO" diff --quiet -- . || { echo 'DIRTY_SOURCE' >&2; exit 2; }
/usr/bin/git -C "$REPO" diff --cached --quiet -- . || { echo 'DIRTY_SOURCE' >&2; exit 2; }

TMP="$(/usr/bin/mktemp -d "${TMPDIR:-/var/tmp}/gram-core-release.XXXXXX")"
trap '/bin/rm -rf "$TMP"' EXIT
SOURCE="$TMP/source"
STAGING="$TMP/staging"

/bin/mkdir -p "$SOURCE/apps" "$SOURCE/packages/macos-lifecycle" "$SOURCE/bin"
(cd "$REPO" && "$PNPM_BIN" build)
# Deploy directly into its final bundle-relative location so pnpm's relative
# workspace/package symlinks are computed for that exact path. Moving a deploy
# tree afterwards can turn otherwise-internal links into escaping links.
(cd "$REPO" && "$PNPM_BIN" --filter @gram/agent deploy --prod --legacy "$SOURCE/apps/agent")
# pnpm legacy deploy adds a convenience self-link for the deployed package
# under .pnpm/node_modules. The runtime never resolves @gram/agent from itself,
# and keeping this link would point outside the sealed apps/agent subtree.
self_link="$SOURCE/apps/agent/node_modules/.pnpm/node_modules/@gram/agent"
if [[ -L "$self_link" ]]; then
  /bin/rm "$self_link"
elif [[ -e "$self_link" ]]; then
  echo 'UNEXPECTED_AGENT_SELF_ENTRY' >&2
  exit 2
fi
/bin/cp -R "$REPO/packages/macos-lifecycle/dist" "$SOURCE/packages/macos-lifecycle/dist"
/bin/cp "$REPO/pnpm-lock.yaml" "$SOURCE/pnpm-lock.yaml"
/bin/cp "$NODE_BIN" "$SOURCE/bin/node"
/bin/chmod 0755 "$SOURCE/bin/node"

/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror "$REPO/platform/macos/native/file-acl.c" -o "$SOURCE/bin/file-acl"
/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror "$REPO/platform/macos/native/peer-owner.c" -o "$SOURCE/bin/peer-owner"
/bin/chmod 0755 "$SOURCE/bin/file-acl" "$SOURCE/bin/peer-owner"

[[ -f "$SOURCE/apps/agent/dist/main.js" ]] || { echo 'AGENT_ENTRY_MISSING' >&2; exit 2; }
[[ -f "$SOURCE/packages/macos-lifecycle/dist/supervisor-cli.js" ]] || { echo 'SUPERVISOR_ENTRY_MISSING' >&2; exit 2; }
[[ -f "$SOURCE/packages/macos-lifecycle/dist/operator-cli.js" ]] || { echo 'OPERATOR_ENTRY_MISSING' >&2; exit 2; }

exec "$NODE_BIN" "$SCRIPT_DIR/seal-core-release.mjs" \
  --source "$SOURCE" --staging "$STAGING" --publish "$DEST" \
  --release-id "$RELEASE_ID" --source-commit "$SOURCE_COMMIT"
