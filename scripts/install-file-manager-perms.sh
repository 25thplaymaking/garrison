#!/usr/bin/env bash
# One-time setup (run as root) for file-manager permission repair on a
# bare-metal install. Not needed with Docker Compose (the panel runs as root
# in its container there).
#
#   sudo bash /opt/garrison/scripts/install-file-manager-perms.sh
#
# Idempotent. It:
#   1. installs the hardened helper root-owned at /usr/local/sbin (NOT writable
#      by the app user),
#   2. grants the app user a NOPASSWD sudoers rule for ONLY that helper,
#   3. one-time normalizes the existing offenders under server-data so already
#      broken files become editable immediately (not just on next save).
set -euo pipefail

REPO_DIR="${GARRISON_DIR:-/opt/garrison}"
BASE="$REPO_DIR/backend/server-data"
APP_USER="${FM_PERM_USER:-www-data}"
APP_GROUP="${FM_PERM_GROUP:-www-data}"
HELPER_SRC="$REPO_DIR/scripts/garrison-fix-perms.sh"
HELPER_DST="/usr/local/sbin/garrison-fix-perms"
SUDOERS_DST="/etc/sudoers.d/garrison-file-manager"

[ "$(id -u)" -eq 0 ] || { echo "must run as root (use sudo)" >&2; exit 1; }
[ -f "$HELPER_SRC" ] || { echo "helper source missing: $HELPER_SRC" >&2; exit 1; }

echo "[1/3] installing helper -> $HELPER_DST (root:root 0755)"
install -m 0755 -o root -g root "$HELPER_SRC" "$HELPER_DST"

echo "[2/3] installing sudoers rule -> $SUDOERS_DST"
tmp_sudoers="$(mktemp)"
printf '%s ALL=(root) NOPASSWD: %s\n' "$APP_USER" "$HELPER_DST" > "$tmp_sudoers"
visudo -cf "$tmp_sudoers"
install -m 0440 -o root -g root "$tmp_sudoers" "$SUDOERS_DST"
rm -f "$tmp_sudoers"
visudo -cf "$SUDOERS_DST"

echo "[3/3] one-time normalize existing offenders under $BASE"
if [ -d "$BASE" ]; then
  # Only touch offenders (cheap on a 120G tree): dirs missing setgid/group-write,
  # files missing group-write, and anything not in the app group.
  find "$BASE" ! -group "$APP_GROUP" -exec chgrp "$APP_GROUP" {} + || true
  find "$BASE" -type d ! -perm -2020 -exec chmod g+rwxs {} + || true
  find "$BASE" -type f ! -perm -020 -exec chmod g+rw {} + || true
  echo "  normalized."
else
  echo "  base $BASE not present yet — skipping cleanup."
fi

echo "done. Verify:  sudo -n -u $APP_USER sudo -n $HELPER_DST $BASE/.probe 2>&1 || true"
