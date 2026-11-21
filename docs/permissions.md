# File permissions on a bare-metal install

**Not needed with Docker Compose.** There the panel runs as root inside its
container and can edit every server file.

On a bare-metal install the panel runs as a normal user (for example
`www-data`), while game containers write logs, mods and profile files as root.
The file manager then hits "Permission denied" on those files.

Garrison already starts containers with `umask 002` and group-writable, setgid
server folders, which covers most files. For the rest it can call a small,
hardened helper through sudo. The helper:

- takes exactly one absolute path,
- refuses anything outside `SERVER_DATA_ROOT` (after resolving symlinks),
- changes ownership and adds owner/group write on that one path only, never recursively,
- acts through an opened file descriptor so a swapped symlink cannot redirect it.

Install it once, as root:

```bash
sudo GARRISON_DIR=/opt/garrison FM_PERM_USER=www-data FM_PERM_GROUP=www-data \
  bash /opt/garrison/scripts/install-file-manager-perms.sh
```

That copies `scripts/garrison-fix-perms.sh` to `/usr/local/sbin/garrison-fix-perms`
(root-owned), adds a sudoers rule that lets the panel user run only that helper,
and fixes existing files once. If your server data is not under
`$GARRISON_DIR/backend/server-data`, set `FM_PERM_BASE` in the helper's
environment (or edit `BASE` at the top of the script) to your `SERVER_DATA_ROOT`.

Set `PERM_REPAIR_HELPER` in `.env` if you install the helper somewhere else.
The panel logs at startup whether the helper is ready.
