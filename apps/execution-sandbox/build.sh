#!/bin/sh
set -eu
[ "$#" -eq 1 ] || { echo 'usage: build.sh ABSOLUTE_OUTPUT' >&2; exit 2; }
case "$1" in /*) ;; *) exit 2;; esac
umask 077
build_file=$(mktemp "${1}.build.XXXXXX")
trap 'rm -f -- "$build_file"' EXIT HUP INT TERM
cc -std=c11 -O2 -Wall -Wextra -Werror -fstack-protector-strong -D_FORTIFY_SOURCE=3 -fPIE -pie -Wl,-z,relro,-z,now "$(dirname "$0")/entry.c" -o "$build_file"
chmod 700 "$build_file"
# Same-directory hard link atomically publishes only if the destination is absent.
ln -T -- "$build_file" "$1"
