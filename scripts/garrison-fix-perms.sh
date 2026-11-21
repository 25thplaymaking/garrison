#!/usr/bin/env bash
# Garrison file-manager permission helper (bare-metal installs only).
#
# Invoked as root (via a dedicated NOPASSWD sudoers rule) by the backend when a
# file-manager write hits EACCES on a container-created, root-owned path. It is
# deliberately minimal and hardened, because it is reachable from the
# internet-facing backend user:
#
#   * takes exactly ONE absolute path argument
#   * canonicalizes it (resolving symlinks + ..) and REFUSES anything that does
#     not resolve strictly inside the server-data base
#   * only ever chowns to the app user and adds owner/group-write; never touches mode
#     bits outside the base, never runs recursively over arbitrary trees
#
# Install it root-owned and NOT writable by the app user (see
# scripts/install-file-manager-perms.sh). Keep this hardening intact.
set -euo pipefail

BASE="${FM_PERM_BASE:-/opt/garrison/backend/server-data}"
APP_USER="${FM_PERM_USER:-www-data}"
APP_GROUP="${FM_PERM_GROUP:-www-data}"

die() { printf 'garrison-fix-perms: %s\n' "$*" >&2; exit 2; }

[ "$#" -eq 1 ] || die "exactly one path argument is required"
raw="$1"
case "$raw" in
  /*) ;;
  *) die "path must be absolute" ;;
esac

# Canonicalize without requiring existence (target file may not exist yet).
canon="$(realpath -m -- "$raw")"
base_canon="$(realpath -m -- "$BASE")"
case "$canon/" in
  "$base_canon"/*) ;;
  *) die "refusing to touch a path outside $base_canon: $canon" ;;
esac

# Find the nearest EXISTING node (the target, or its closest existing parent),
# then re-resolve it to defeat any symlink that appeared along the way.
node="$canon"
while [ ! -e "$node" ]; do
  node="$(dirname "$node")"
  [ "$node" = "$base_canon" ] && break
done
real_node="$(realpath -- "$node")"
case "$real_node/" in
  "$base_canon"/*) ;;
  *) die "resolved node escaped base: $real_node" ;;
esac
[ "$real_node" = "$base_canon" ] && die "refusing to operate on the base root itself"

# TOCTOU hardening. The app user can write inside the base, so between the
# realpath check above and a chown/chmod by path it could replace a parent
# directory with a symlink to /etc and have root chown or chmod something
# outside the base. chown/chmod/chgrp follow symlinks by default, so every
# mutation below goes through an OPENED file descriptor instead of a path:
# open the node, verify that the inode we actually hold resolves inside the
# base, then act on /proc/self/fd/N (the kernel resolves that to the open
# inode, never re-walking the user-controlled path).
#
# Usage: with_verified_node <path> <cmd> [args...]  — runs `cmd args... <fdpath>`
with_verified_node() {
  local path="$1"; shift
  local held
  exec 3<"$path" || die "cannot open $path"
  # /proc/self inside $(...) is the subshell, but fd 3 is inherited, so the
  # magic link still names the inode this process holds open.
  held="$(realpath -e -- /proc/self/fd/3 2>/dev/null || true)"
  if [ -z "$held" ]; then
    exec 3<&-
    die "opened node no longer resolves: $path"
  fi
  case "$held/" in
    "$base_canon"/*) ;;
    *) exec 3<&-; die "opened node escaped base: $held" ;;
  esac
  if [ "$held" = "$base_canon" ]; then
    exec 3<&-
    die "refusing to operate on the base root itself"
  fi
  "$@" /proc/self/fd/3
  exec 3<&-
}

# Make every directory from the target up to (not including) the base owned by
# the app group, group-writable, and setgid so new children inherit the group.
dir="$real_node"
[ -d "$dir" ] || dir="$(dirname "$dir")"
while [ "$dir" != "$base_canon" ] && [ "$dir" != "/" ]; do
  with_verified_node "$dir" chgrp "$APP_GROUP"
  with_verified_node "$dir" chmod u+rwx,g+rwxs
  dir="$(dirname "$dir")"
done

# Fix the target node itself (single node only — never recursive).
if [ -d "$real_node" ]; then
  with_verified_node "$real_node" chown "$APP_USER:$APP_GROUP"
  with_verified_node "$real_node" chmod u+rwx,g+rwxs
elif [ -e "$real_node" ]; then
  with_verified_node "$real_node" chown "$APP_USER:$APP_GROUP"
  # Owner permissions take precedence over group permissions after chown.
  # A root-owned 0444 file must become owner-writable as well as group-writable.
  with_verified_node "$real_node" chmod ug+rw
fi

echo "ok"
