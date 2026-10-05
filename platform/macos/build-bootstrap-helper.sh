#!/bin/bash
set -euo pipefail

if [[ $# -ne 1 || "$1" != /* ]]; then
  echo "usage: build-bootstrap-helper.sh /absolute/new/output/file-acl" >&2
  exit 64
fi
if [[ "$(/usr/bin/uname -s)" != "Darwin" || "$(/usr/bin/uname -m)" != "arm64" ]]; then
  echo "UNSUPPORTED_HOST" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && /bin/pwd -P)"
SOURCE="$SCRIPT_DIR/native/file-acl.c"
OUTPUT="$1"
PARENT="$(dirname "$OUTPUT")"

[[ -f "$SOURCE" && ! -L "$SOURCE" ]] || { echo "UNTRUSTED_SOURCE" >&2; exit 2; }
[[ -d "$PARENT" && ! -e "$OUTPUT" ]] || { echo "UNSAFE_OUTPUT" >&2; exit 2; }
[[ -x /usr/bin/clang ]] || { echo "CLANG_UNAVAILABLE" >&2; exit 2; }

/usr/bin/clang -std=c11 -O2 -Wall -Wextra -Werror "$SOURCE" -o "$OUTPUT"
/bin/chmod 0755 "$OUTPUT"

[[ -f "$OUTPUT" && ! -L "$OUTPUT" && -x "$OUTPUT" ]] || {
  /bin/rm -f "$OUTPUT"
  echo "BUILD_FAILED" >&2
  exit 2
}

SOURCE_SHA="$(/usr/bin/shasum -a 256 "$SOURCE" | /usr/bin/awk '{print $1}')"
BINARY_SHA="$(/usr/bin/shasum -a 256 "$OUTPUT" | /usr/bin/awk '{print $1}')"
printf 'BOOTSTRAP_HELPER_BUILT source_sha256=%s binary_sha256=%s\n' "$SOURCE_SHA" "$BINARY_SHA"
