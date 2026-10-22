#!/bin/sh
set -eu

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
    printf '%s\n' 'usage: build.sh BUILD_DIRECTORY' >&2
    exit 2
fi

source_dir=$(CDPATH= cd -P "$(dirname -- "$0")" && pwd)
case "$1" in
    /*) build_dir=$1 ;;
    *) build_dir=$PWD/$1 ;;
esac
mkdir -p -- "$build_dir"
cc -std=c11 -O2 -Wall -Wextra -Werror \
    "$source_dir/native.c" -o "$build_dir/gram-owner-fs-native"
cc -std=c11 -O2 -Wall -Wextra -Werror \
    "$source_dir/entry.c" -o "$build_dir/gram-owner-fs-entry"
