"""The call-target-limit patch: fits only the exact code it was written for.

The byte strings below are the real instruction encodings from
ArmaReforgerServer 1.9.0.37, laid out the way the patch expects to find them:
five index decodes together in the interpreter, one in the far-away
disassembly dumper, nine flag tests after the interpreter decodes, and the
compiler's flag/emit sequence.
"""
import os
import sys
from pathlib import Path

import pytest

BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-with-sufficient-length-for-hs256-32b")

import services.reforger_launch as reforger_launch  # noqa: E402
from services import reforger_orchestrator  # noqa: E402
from services import reforger_script_limit_patch as patch  # noqa: E402

h = bytes.fromhex
TABLE = h("488b88a8000000")            # mov rcx, [rax+0xa8]
DECODE_R11 = h("41c1eb0d" "4181e3ffff0100") + TABLE
DECODE_EBX = h("c1eb0d" "81e3ffff0100") + TABLE
DECODE_R8 = h("41c1e80d" "4181e0ffff0100") + TABLE
DECODE_EBP = h("c1ed0d" "81e5ffff0100") + TABLE
TEST_R11 = h("41f7c300000040")
TEST_R15 = h("41f7c700000040")
SHR_30 = h("41c1eb1e" "4183e301")
OR_FLAG = h("814c242800000200")
AND_FLAG = h("8164242800000200")
EMIT = h("b8ff1f0000" "488b542420" "2302" "c1e10d" "09c1" "890a")
PAD = b"\x90" * 64


def build_binary(*, flag_tests=9, interpreter_decodes=(DECODE_R11, DECODE_EBX, DECODE_EBX, DECODE_R8, DECODE_EBX)):
    compiler = PAD + OR_FLAG + PAD + AND_FLAG + PAD + EMIT + PAD
    dumper = DECODE_EBP + PAD
    far = b"\x90" * 0x2000
    interpreter = PAD.join(interpreter_decodes) + PAD + SHR_30 + PAD
    interpreter += PAD.join([TEST_R11, TEST_R15] * 5)[: (len(TEST_R11) + len(PAD)) * flag_tests - len(PAD)]
    return compiler + dumper + far + interpreter + far


def test_fits_and_moves_flag_a_to_bit_12():
    stock = build_binary()
    edits = patch.plan_edits(stock)

    assert len(edits) == 19
    patched = patch.patch_bytes(stock)
    assert len(patched) == len(stock)
    assert patched.count(h("ffff0300")) == 6 and h("ffff0100") not in patched
    assert patched.count(h("f7c300100000")) + patched.count(h("f7c700100000")) == 9
    assert h("41c1eb0c4183e301") in patched          # flag extract reads bit 12
    assert h("814c242800000080") in patched          # flag A kept as bit 31 before the rotate
    assert h("8164242800000080") in patched
    assert h("2302c1c10d09c1890a") in patched        # shl 13 became rol 13


def test_rotate_puts_flag_a_on_bit_12_and_an_18_bit_index_on_bits_13_to_30():
    # The arithmetic the patched compiler performs for index 144,650 (over the
    # stock 131,071) with both flags set.
    index, flag_a, flag_b = 0x2350A, 0x80000000, 0x40000
    operand = index | flag_a | flag_b
    word = ((operand << 13) | (operand >> 19)) & 0xFFFFFFFF | 0x107   # rol 13, then the low bits

    assert (word >> 13) & 0x3FFFF == index
    assert word & 0x1000                 # flag A
    assert word & 0x80000000             # flag B
    assert word & 0xFFF == 0x107         # opcode and length untouched


@pytest.mark.parametrize("binary", [
    build_binary(flag_tests=8),
    build_binary(interpreter_decodes=(DECODE_R11, DECODE_EBX, DECODE_EBX, DECODE_R8)),
    build_binary().replace(OR_FLAG, b"\x90" * len(OR_FLAG)),
    build_binary().replace(EMIT, b"\x90" * len(EMIT)),
    build_binary() + OR_FLAG,
    b"\x90" * 4096,
], ids=["one flag test missing", "one decode missing", "no flag set", "no emit", "second flag set", "unrelated"])
def test_refuses_any_binary_that_differs(binary):
    with pytest.raises(patch.PatchError):
        patch.plan_edits(binary)


def test_patched_copy_is_separate_reused_and_rebuilt_after_a_game_update(tmp_path):
    binary = tmp_path / "ArmaReforgerServer"
    stock = build_binary()
    binary.write_bytes(stock)

    target = patch.ensure_patched_binary(binary)

    assert target.name == "ArmaReforgerServer.calltargets18"
    assert binary.read_bytes() == stock
    assert target.read_bytes() == patch.patch_bytes(stock)

    target.write_bytes(b"sentinel")
    assert patch.ensure_patched_binary(binary).read_bytes() == b"sentinel"   # same stock file: reused

    updated = stock + b"\x90"
    binary.write_bytes(updated)
    assert patch.ensure_patched_binary(binary).read_bytes() == patch.patch_bytes(updated)


def test_launch_shim_swaps_only_the_engine_binary(tmp_path):
    (tmp_path / "ArmaReforgerServer").write_bytes(build_binary())

    swapped = reforger_launch.with_script_limit_patch(["./ArmaReforgerServer", "-maxFPS", "120"], str(tmp_path))
    assert swapped == ["./ArmaReforgerServer.calltargets18", "-maxFPS", "120"]
    assert (tmp_path / "ArmaReforgerServer.calltargets18").is_file()

    steamcmd = ["/steamcmd/steamcmd.sh", "+quit"]
    assert reforger_launch.with_script_limit_patch(steamcmd, str(tmp_path)) == steamcmd


def test_launch_shim_runs_the_stock_binary_when_the_patch_does_not_fit(tmp_path, capsys):
    (tmp_path / "ArmaReforgerServer").write_bytes(b"\x90" * 4096)
    arguments = ("./ArmaReforgerServer", "-maxFPS", "120")

    assert reforger_launch.with_script_limit_patch(arguments, str(tmp_path)) == arguments
    assert "running the stock binary" in capsys.readouterr().out


SERVER = {
    "id": "srv-1",
    "container_name": "reforger-srv-1",
    "config_path": "/data/srv-1/Configs/server-config.json",
    "profile_path": "/data/srv-1/profile",
    "workshop_path": "/data/srv-1/workshop",
    "ports": {"game": 2001, "query": 17777, "rcon": 19999},
    # A fixed RCON password: without one each config build generates a new one.
    "config": {"rcon": {"password": "fixed-test-password"}},
    "mods": [],
}


def test_switch_reaches_the_container_only_when_on():
    off_env = reforger_orchestrator.build_container_environment(SERVER)
    on_env = reforger_orchestrator.build_container_environment({**SERVER, "script_limit_patch": True})

    assert reforger_orchestrator.SCRIPT_LIMIT_PATCH_ENV not in off_env
    assert on_env[reforger_orchestrator.SCRIPT_LIMIT_PATCH_ENV] == "1"

    binds = lambda server: {v["bind"] for v in reforger_orchestrator.build_container_volumes(server).values()}  # noqa: E731
    assert "/app/reforger_script_limit_patch.py" not in binds(SERVER)
    assert "/app/reforger_script_limit_patch.py" in binds({**SERVER, "script_limit_patch": True})


@pytest.mark.parametrize("container_value, wanted, stale", [
    (None, False, False),   # untouched servers are never recreated for this
    (None, True, True),
    ("1", True, False),
    ("1", False, True),     # turning it off must replace the container too
])
def test_toggling_the_switch_marks_the_container_stale(monkeypatch, container_value, wanted, stale):
    import asyncio

    server = {**SERVER, "script_limit_patch": wanted}
    current = dict(reforger_orchestrator.build_container_environment(SERVER))
    if container_value is not None:
        current[reforger_orchestrator.SCRIPT_LIMIT_PATCH_ENV] = container_value

    async def fake_environment(_name):
        return current

    monkeypatch.setattr(reforger_orchestrator.docker_agent, "get_container_environment", fake_environment)
    assert asyncio.run(reforger_orchestrator.container_environment_is_stale(server)) is stale
