import errno
import os
import sys
from pathlib import Path

import pytest
import services.server_data_permissions as permissions


def _invoke_rmtree_error_handler(kwargs, failing_path: Path, exc: BaseException) -> None:
    if sys.version_info >= (3, 12):
        kwargs["onexc"](os.unlink, str(failing_path), exc)
    else:
        kwargs["onerror"](os.unlink, str(failing_path), (type(exc), exc, None))


def test_tree_removal_repairs_permission_blocker_then_retries(monkeypatch, tmp_path):
    server_root = tmp_path / "server"
    blocker = server_root / "profile" / "locked.json"
    blocker.parent.mkdir(parents=True)
    blocker.write_text("{}", encoding="utf-8")
    rmtree_calls = []
    repaired = []

    def fake_rmtree(path, **kwargs):
        rmtree_calls.append(Path(path))
        if len(rmtree_calls) == 1:
            exc = PermissionError(errno.EACCES, "Permission denied", str(blocker))
            _invoke_rmtree_error_handler(kwargs, blocker, exc)
        blocker.unlink()
        blocker.parent.rmdir()
        server_root.rmdir()

    monkeypatch.setattr(permissions.shutil, "rmtree", fake_rmtree)
    monkeypatch.setattr(
        permissions,
        "repair_editable_permissions",
        lambda path: repaired.append(Path(path)) or True,
    )

    permissions.remove_tree_with_permission_repair(server_root)

    assert rmtree_calls == [server_root, server_root]
    assert repaired == [blocker]
    assert not server_root.exists()


def test_tree_removal_does_not_loop_on_same_permission_blocker(monkeypatch, tmp_path):
    server_root = tmp_path / "server"
    blocker = server_root / "locked.json"
    blocker.parent.mkdir()
    blocker.write_text("{}", encoding="utf-8")
    repairs = []

    def always_blocked(path, **kwargs):
        exc = PermissionError(errno.EACCES, "Permission denied", str(blocker))
        _invoke_rmtree_error_handler(kwargs, blocker, exc)

    monkeypatch.setattr(permissions.shutil, "rmtree", always_blocked)
    monkeypatch.setattr(
        permissions,
        "repair_editable_permissions",
        lambda path: repairs.append(Path(path)) or True,
    )

    with pytest.raises(PermissionError, match="Permission denied"):
        permissions.remove_tree_with_permission_repair(server_root)

    assert repairs == [blocker]


def test_tree_repair_uses_callback_path_when_exception_has_only_basename(monkeypatch, tmp_path):
    from routes.servers_files import _remove_fs_entry
    root = tmp_path / "addons"
    blocker = root / "mod" / "ServerData.json"
    blocker.parent.mkdir(parents=True)
    blocker.write_text("{}")
    real_rmtree = permissions.shutil.rmtree
    repaired = []

    def remove(path, **kwargs):
        if not repaired:
            _invoke_rmtree_error_handler(kwargs, blocker, PermissionError(errno.EACCES, "denied", blocker.name))
        return real_rmtree(path, **kwargs)

    monkeypatch.setattr(permissions.shutil, "rmtree", remove)
    monkeypatch.setattr(permissions, "repair_editable_permissions", lambda p: repaired.append(p) or True)
    assert _remove_fs_entry(root) is None
    assert repaired == [blocker]
    assert not root.exists()


def test_unlink_repairs_parent_and_leaves_neighbor(monkeypatch, tmp_path):
    target = tmp_path / "mod.pbo"
    target.write_text("mod")
    neighbor = tmp_path / "keep.pbo"
    neighbor.write_text("keep")
    real_unlink = Path.unlink
    repaired = []

    def unlink(path, *args, **kwargs):
        if path == target and not repaired:
            raise PermissionError(errno.EACCES, "denied", str(path))
        return real_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)
    monkeypatch.setattr(permissions, "repair_editable_permissions", lambda p: repaired.append(p) or True)
    permissions.unlink_with_permission_repair(target)
    assert repaired == [target.parent]
    assert not target.exists() and neighbor.exists()


def test_write_repairs_root_owned_file_once(monkeypatch, tmp_path):
    target = tmp_path / "server.json"
    real_write = Path.write_text
    repaired = []

    def write(path, *args, **kwargs):
        if path == target and not repaired:
            raise PermissionError(errno.EACCES, "denied", str(path))
        return real_write(path, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", write)
    monkeypatch.setattr(permissions, "repair_editable_permissions", lambda p: repaired.append(p) or True)
    permissions.write_text_with_permission_repair(target, '{"value": 1}')
    assert target.read_text() == '{"value": 1}'
    assert repaired == [target]
