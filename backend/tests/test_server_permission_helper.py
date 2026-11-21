"""Exercise the real host helper on Linux without requiring root or sudo."""
import os
from pathlib import Path
import subprocess

import pytest

pytestmark = pytest.mark.skipif(os.name != "posix", reason="Linux host permission semantics")
HELPER = Path(__file__).resolve().parents[2] / "scripts" / "garrison-fix-perms.sh"


def run_helper(base, target):
    import grp
    import pwd
    env = {**os.environ, "FM_PERM_BASE": str(base),
           "FM_PERM_USER": pwd.getpwuid(os.getuid()).pw_name,
           "FM_PERM_GROUP": grp.getgrgid(os.getgid()).gr_name}
    return subprocess.run(["bash", str(HELPER), str(target)], env=env, capture_output=True, text=True)


def test_read_only_owner_becomes_writable_without_world_write(tmp_path):
    base = tmp_path / "server-data"
    directory = base / "server" / "mod"
    directory.mkdir(parents=True)
    target = directory / "ServerData.json"
    target.write_text("old")
    target.chmod(0o444)
    directory.chmod(0o555)
    result = run_helper(base, target)
    assert result.returncode == 0, result.stderr
    assert target.stat().st_mode & 0o600 == 0o600
    assert directory.stat().st_mode & 0o2700 == 0o2700
    assert not target.stat().st_mode & 0o002
    assert not directory.stat().st_mode & 0o002
    target.write_text("updated")


def test_base_outside_and_symlink_escape_are_refused(tmp_path):
    base = tmp_path / "server-data"
    base.mkdir()
    outside = tmp_path / "protected"
    outside.write_text("unchanged")
    outside.chmod(0o444)
    link = base / "escape"
    link.symlink_to(outside)
    for target in (base, outside, link):
        assert run_helper(base, target).returncode != 0
    assert outside.stat().st_mode & 0o777 == 0o444
    assert outside.read_text() == "unchanged"
