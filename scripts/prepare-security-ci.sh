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
stat -c '%n uid=%u mode=%a' /opt /var/lib /var/cache
sudo python3 scripts/stage-sandbox-node.py
stat -c '%n uid=%u mode=%a' /var/lib /var/cache /var/lib/gram-sandbox-runtime
uname -r
/usr/bin/bwrap --version
sha256sum /usr/bin/bwrap /usr/local/libexec/gram-sandbox-entry /var/lib/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified/bin/node

# Mandatory owner-filesystem tests use separately pinned root-owned artifacts.
# They never replace the ordinary M5 entry or reuse its execution authority.
sh apps/filesystem-worker/build.sh "$temporary/owner-filesystem"
test ! -e /var/lib/gram-owner-native-ci
sudo install -d -o root -g root -m 0755 /var/lib/gram-owner-native-ci
sudo install -o root -g root -m 0755 "$temporary/owner-filesystem/gram-owner-fs-entry" /var/lib/gram-owner-native-ci/entry
sudo install -o root -g root -m 0755 "$temporary/owner-filesystem/gram-owner-fs-native" /var/lib/gram-owner-native-ci/native
sudo install -o root -g root -m 0644 apps/filesystem-worker/worker.mjs /var/lib/gram-owner-native-ci/worker.mjs
python3 - <<'PY'
import hashlib, json, os, pathlib
paths = {
  'bubblewrap': '/usr/bin/bwrap',
  'node': '/var/lib/gram-sandbox-runtime/node-24-pnpm-10.34.5-verified/bin/node',
  'entry': '/var/lib/gram-owner-native-ci/entry',
  'native': '/var/lib/gram-owner-native-ci/native',
  'worker': '/var/lib/gram-owner-native-ci/worker.mjs',
}
manifest = pathlib.Path(os.environ['RUNNER_TEMP']) / 'gram-owner-native-artifacts.json'
manifest.write_text(json.dumps({key: {'path': value, 'sha256': hashlib.sha256(pathlib.Path(value).read_bytes()).hexdigest()} for key, value in paths.items()}))
with open(os.environ['GITHUB_ENV'], 'a') as output:
    output.write('GRAM_POSIX_NATIVE_ARTIFACTS=' + str(manifest) + '\n')
PY
