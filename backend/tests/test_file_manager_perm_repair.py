"""Unit tests for the file-manager permission self-repair helper."""

import os
import subprocess
from pathlib import Path

import pytest

# routes.servers and routes.servers_files import each other; importing the
# former first initializes both in the order the app uses (servers defines the
# helpers that servers_files pulls in, then imports servers_files at its tail).
import routes.servers  # noqa: F401
import routes.servers_files as sf
import services.server_data_permissions as permissions

requires_sudo = pytest.mark.skipif(
    permissions.resolve_sudo() is None,
    reason="no executable sudo on this host",
)


def test_repair_returns_false_when_helper_absent(monkeypatch):
    monkeypatch.setattr(permissions.os.path, "exists", lambda p: False)
    called = False

    def _fail(*a, **k):  # pragma: no cover - must not be reached
        nonlocal called
        called = True
        raise AssertionError("subprocess.run should not be called")

    monkeypatch.setattr(permissions.subprocess, "run", _fail)
    assert sf._repair_editable_permissions(Path("/opt/garrison/backend/server-data/s/x")) is False
    assert called is False


@requires_sudo
def test_repair_invokes_sudo_helper_with_path(monkeypatch):
    captured = {}
    monkeypatch.setattr(permissions.os.path, "exists", lambda p: True)

    def _run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(cmd, 0, b"ok", b"")

    monkeypatch.setattr(permissions.subprocess, "run", _run)

    target = Path("/opt/garrison/backend/server-data/s/config/server.json")
    assert sf._repair_editable_permissions(target) is True
    assert captured["cmd"][0] == permissions.resolve_sudo()
    assert captured["cmd"][1:3] == ["-n", permissions.PERM_REPAIR_HELPER]
    assert captured["cmd"][3] == str(target)
    assert captured["kwargs"].get("check") is True
    assert captured["kwargs"].get("timeout")


@requires_sudo
def test_repair_swallows_subprocess_failure(monkeypatch):
    monkeypatch.setattr(permissions.os.path, "exists", lambda p: True)

    def _boom(cmd, **kwargs):
        raise subprocess.CalledProcessError(1, cmd, stderr=b"denied")

    monkeypatch.setattr(permissions.subprocess, "run", _boom)
    assert sf._repair_editable_permissions(Path("/opt/garrison/backend/server-data/s/x")) is False


@requires_sudo
def test_repair_never_resolves_sudo_through_the_service_path(monkeypatch):
    """The service's PATH holds only the backend venv — a bare "sudo" is a no-op.

    Regression: `subprocess.run(["sudo", ...])` raised FileNotFoundError under
    that PATH, so every repair silently returned False and operators saw a raw
    "[Errno 13] Permission denied" for files the dashboard owned.
    """
    monkeypatch.setenv("PATH", "/opt/garrison/backend/venv/bin")
    monkeypatch.setattr(
        permissions.shutil, "which", lambda name: "/opt/garrison/backend/venv/bin/sudo"
    )
    monkeypatch.setattr(permissions.os.path, "exists", lambda p: True)
    captured = {}

    def _run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, b"ok", b"")

    monkeypatch.setattr(permissions.subprocess, "run", _run)

    target = Path("/opt/garrison/backend/server-data/s/config/server.json")
    assert sf._repair_editable_permissions(target) is True

    sudo = captured["cmd"][0]
    assert os.path.isabs(sudo), f"sudo must be absolute, got {sudo!r}"
    absolute_candidate = next(
        (c for c in permissions.SUDO_CANDIDATES if os.access(c, os.X_OK)), None
    )
    assert sudo == absolute_candidate, "an absolute candidate must win over PATH"
    assert os.access(sudo, os.X_OK), sudo


def test_readiness_reports_uninstalled_helper(monkeypatch):
    monkeypatch.setattr(permissions.os.path, "exists", lambda p: False)
    ok, detail = permissions.repair_readiness()
    assert ok is False
    assert permissions.PERM_REPAIR_HELPER in detail


@requires_sudo
def test_readiness_reports_ready_host(monkeypatch):
    monkeypatch.setattr(permissions.os.path, "exists", lambda p: True)
    ok, detail = permissions.repair_readiness()
    assert ok is True
    assert permissions.PERM_REPAIR_HELPER in detail
    assert os.path.isabs(detail.split()[0])
