#!/bin/bash
set -euo pipefail

# Ephemeral GitHub-hosted runner setup only. Never call from the agent or a Task.
test "${GITHUB_ACTIONS:-}" = true
test "$(id -u)" != 0
python3 - <<'PY'
import ctypes
library = ctypes.CDLL(None, use_errno=True)
abi = library.syscall(444, 0, 0, 1)
print('Measured Landlock ABI:', abi)
if abi < 7:
    raise SystemExit('Required security profile unavailable; no fallback or skip')
PY
sudo apt-get update
sudo apt-get install -y bubblewrap meson ninja-build pkg-config libcap-dev
temporary=$(mktemp -d /tmp/gram-security-ci.XXXXXXXX)
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 \
  https://github.com/containers/bubblewrap/releases/download/v0.11.1/bubblewrap-0.11.1.tar.xz \
  --output "$temporary/bubblewrap.tar.xz"
printf '%s  %s\n' c1b7455a1283b1295879a46d5f001dfd088c0bb0f238abb5e128b3583a246f71 \
  "$temporary/bubblewrap.tar.xz" | sha256sum --check --strict
tar --extract --xz --file "$temporary/bubblewrap.tar.xz" --directory "$temporary"
meson setup "$temporary/build" "$temporary/bubblewrap-0.11.1" -Dtests=false -Dman=disabled
meson compile -C "$temporary/build"
# Existing distro AppArmor policy still applies at its normal /usr/bin/bwrap
# path. No global user-namespace/sysctl/AppArmor restrictions are disabled.
sudo install -o root -g root -m 0755 "$temporary/build/bwrap" /usr/bin/bwrap
test ! -u /usr/bin/bwrap
test ! -g /usr/bin/bwrap
sh apps/execution-sandbox/build.sh "$temporary/gram-sandbox-entry"
sudo install -d -o root -g root -m 0755 /usr/local/libexec
test ! -e /usr/local/libexec/gram-sandbox-entry
sudo install -o root -g root -m 0755 "$temporary/gram-sandbox-entry" /usr/local/libexec/gram-sandbox-entry
sudo python3 scripts/stage-sandbox-node.py
uname -r
/usr/bin/bwrap --version
sha256sum /usr/bin/bwrap /usr/local/libexec/gram-sandbox-entry /opt/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified/bin/node
