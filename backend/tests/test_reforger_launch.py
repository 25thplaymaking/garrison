"""Regression coverage for the managed Reforger launch shim."""

import subprocess

import pytest

import services.reforger_launch as reforger_launch
from services.reforger_launch import (
    main,
    resolve_upstream_launch_path,
    without_nothrow,
)


def test_without_nothrow_filters_only_the_diagnostic_suppression_switch():
    arguments = [
        "./ArmaReforgerServer",
        "-backendlog",
        "-nothrow",
        "-maxFPS",
        "120",
    ]

    assert without_nothrow(arguments) == [
        "./ArmaReforgerServer",
        "-backendlog",
        "-maxFPS",
        "120",
    ]


def test_without_nothrow_preserves_tuple_shape_and_case_insensitively_filters():
    assert without_nothrow(("server", "-NoThrow", "-profile", "/home/profile")) == (
        "server",
        "-profile",
        "/home/profile",
    )


def test_resolve_upstream_launch_path_supports_cached_legacy_image(tmp_path):
    legacy_launcher = tmp_path / "launch.py"
    legacy_launcher.write_text("", encoding="utf-8")

    assert resolve_upstream_launch_path(
        (str(tmp_path / "app" / "launch.py"), str(legacy_launcher))
    ) == str(legacy_launcher)


def test_resolve_upstream_launch_path_reports_every_checked_layout(tmp_path):
    current = str(tmp_path / "app" / "launch.py")
    legacy = str(tmp_path / "launch.py")

    with pytest.raises(
        FileNotFoundError,
        match="Upstream Reforger launcher not found",
    ) as exc_info:
        resolve_upstream_launch_path((current, legacy))

    assert current in str(exc_info.value)
    assert legacy in str(exc_info.value)


def test_main_filters_the_upstream_launcher_process_boundary(tmp_path, monkeypatch):
    captured = []

    class FakeProcess:
        def wait(self):
            return 0

    def fake_popen(arguments, *args, **kwargs):
        captured.append(arguments)
        return FakeProcess()

    upstream = tmp_path / "launch.py"
    upstream.write_text(
        "import subprocess\nsubprocess.Popen(['server', '-backendlog', '-nothrow']).wait()\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(subprocess, "Popen", fake_popen)

    main(str(upstream))

    assert captured == [["server", "-backendlog"]]


def test_main_discovers_legacy_launcher_before_filtering(tmp_path, monkeypatch):
    captured = []

    class FakeProcess:
        def wait(self):
            return 0

    def fake_popen(arguments, *args, **kwargs):
        captured.append(arguments)
        return FakeProcess()

    legacy_launcher = tmp_path / "launch.py"
    legacy_launcher.write_text(
        "import subprocess\nsubprocess.Popen(['server', '-nothrow']).wait()\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        reforger_launch,
        "UPSTREAM_LAUNCH_PATHS",
        (str(tmp_path / "app" / "launch.py"), str(legacy_launcher)),
    )
    monkeypatch.setattr(subprocess, "Popen", fake_popen)

    main()

    assert captured == [["server"]]


UPSTREAM_WITH_INSTALL = (
    "import os, subprocess\n"
    "if os.environ['SKIP_INSTALL'] in ['', 'false']:\n"
    "    subprocess.Popen(['/steamcmd/steamcmd.sh', 'validate']).wait()\n"
    "subprocess.Popen(['./ArmaReforgerServer', '-nothrow']).wait()\n"
)


def _run_container_start(tmp_path, monkeypatch):
    """One start of the same container: returns the commands the launcher ran."""
    captured = []

    class FakeProcess:
        def wait(self):
            return 0

    def fake_popen(arguments, *args, **kwargs):
        captured.append(list(arguments))
        return FakeProcess()

    upstream = tmp_path / "launch.py"
    upstream.write_text(UPSTREAM_WITH_INSTALL, encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARMA_BINARY", "./ArmaReforgerServer")
    monkeypatch.setenv("SKIP_INSTALL", "false")   # what the image sets on every start
    monkeypatch.setattr(subprocess, "Popen", fake_popen)
    main(str(upstream))
    return captured


def test_a_crash_restart_does_not_validate_the_game_again(tmp_path, monkeypatch, capsys):
    steam = ["/steamcmd/steamcmd.sh", "validate"]
    engine = ["./ArmaReforgerServer"]

    first = _run_container_start(tmp_path, monkeypatch)
    assert first == [steam, engine]                       # a new container installs and validates

    (tmp_path / "ArmaReforgerServer").write_bytes(b"engine")   # the install it left behind
    second = _run_container_start(tmp_path, monkeypatch)
    assert second == [engine]                             # the restart goes straight to the engine
    assert "skipping the Steam check" in capsys.readouterr().out


def test_the_game_is_validated_again_once_the_window_has_passed(tmp_path, monkeypatch):
    import os as _os

    _run_container_start(tmp_path, monkeypatch)
    (tmp_path / "ArmaReforgerServer").write_bytes(b"engine")
    marker = tmp_path / reforger_launch.INSTALL_MARKER_NAME
    stale = marker.stat().st_mtime - reforger_launch.INSTALL_MAX_AGE_SECONDS - 60
    _os.utime(marker, (stale, stale))

    assert _run_container_start(tmp_path, monkeypatch)[0] == ["/steamcmd/steamcmd.sh", "validate"]


def test_a_missing_binary_always_installs(tmp_path, monkeypatch):
    _run_container_start(tmp_path, monkeypatch)   # marker written, but no binary on disk

    assert _run_container_start(tmp_path, monkeypatch)[0] == ["/steamcmd/steamcmd.sh", "validate"]


def test_marker_needs_both_a_recent_stamp_and_the_binary(tmp_path):
    assert reforger_launch.install_recently_validated(tmp_path, "ArmaReforgerServer") is False
    reforger_launch.mark_install_validated(tmp_path)
    (tmp_path / "ArmaReforgerServer").write_bytes(b"engine")
    assert reforger_launch.install_recently_validated(tmp_path, "ArmaReforgerServer") is True
    assert reforger_launch.is_server_binary(["/steamcmd/steamcmd.sh"]) is False
