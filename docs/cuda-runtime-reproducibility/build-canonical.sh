#!/bin/sh
# Run as root inside: unshare --mount --propagation private.
set -eu
[ "$(id -u)" -eq 0 ] || { echo BUILD_REQUIRES_PRIVATE_MOUNT_NAMESPACE >&2; exit 2; }
: "${EXCESS_CUDA_BUILD_ROOT:?Set EXCESS_CUDA_BUILD_ROOT to a fresh build root}"
[ ! -L "$EXCESS_CUDA_BUILD_ROOT" ] || { echo BUILD_ROOT_SYMLINK_BLOCKED >&2; exit 2; }
base=$(realpath -e -- "$EXCESS_CUDA_BUILD_ROOT")
case "$base" in /|/var|/var/tmp|/var/tmp/excess-cuda-canonical|/var/tmp/excess-cuda-canonical/*) exit 2 ;; esac
canonical=/var/tmp/excess-cuda-canonical
mkdir -p -- "$canonical"
[ ! -L "$canonical" ] || { echo CANONICAL_PATH_SYMLINK_BLOCKED >&2; exit 2; }
if mountpoint -q -- "$canonical"; then echo CANONICAL_PATH_ALREADY_MOUNTED >&2; exit 2; fi
mount --bind "$base" "$canonical"
cleanup() { umount -- "$canonical"; }
trap cleanup EXIT HUP INT TERM
export EXCESS_CUDA_CANONICAL_ROOT="$canonical"
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
sh "$script_dir/build-runtimes.sh"
