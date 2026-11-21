"""Raise the Reforger script VM's call-target limit from 131,072 to 262,144.

Why this exists
---------------
Arma Reforger's script VM stores a call instruction as one 32-bit word::

    bits 0-12   opcode, length and one spare bit (bit 12)
    bits 13-29  index of the call target (17 bits)
    bit  30     flag A ("called through an instance")
    bit  31     flag B

The compiler writes ``(flags | index) << 13`` without a range check. A server
whose mods together define more than 131,072 call targets gets an index whose
bit 17 lands on flag A; the VM then calls the wrong target and the server dies
at start with ``NULL pointer to instance`` in ``#InitGlobals``.

What the patch does
-------------------
Bit 12 of the word is unused for these opcodes (3 to 7). Flag A moves there,
which frees bit 30 for the index, so the index is 18 bits wide:

* compiler: flag A is kept as bit 31 of the pre-shift value and the shift
  becomes a rotate, so it lands on bit 12;
* interpreter: the index mask grows from ``0x1ffff`` to ``0x3ffff`` and every
  test of flag A reads bit 12 instead of bit 30.

Every edit replaces bytes in place; no code is moved or added. The width is
fixed by the instruction layout, so it cannot be made a free number: there is
exactly one spare bit.

Safety
------
Sites are found by byte pattern, not by address, and each pattern must match
an exact number of times. A game update that changes any of this code makes
the counts differ and the patch refuses (``PatchError``); the caller then runs
the stock binary. The stock file is never modified: the result is written to
a separate file.

Measured on ArmaReforgerServer and ArmaReforgerServerDiag 1.9.0.37.
"""

from __future__ import annotations

import hashlib
import os
import re
import sys
from pathlib import Path
from typing import List, Tuple

PATCH_VERSION = 1
PATCHED_SUFFIX = ".calltargets18"

STOCK_LIMIT = 1 << 17
PATCHED_LIMIT = 1 << 18

_INDEX_MASK_OLD = bytes.fromhex("ffff0100")
_INDEX_MASK_NEW = bytes.fromhex("ffff0300")
_FLAG_A_WORD_OLD = bytes.fromhex("00000040")  # bit 30 of the instruction word
_FLAG_A_WORD_NEW = bytes.fromhex("00100000")  # bit 12 of the instruction word
_FLAG_A_OPERAND_OLD = bytes.fromhex("00000200")  # bit 17 before the shift
_FLAG_A_OPERAND_NEW = bytes.fromhex("00000080")  # bit 31 before the rotate

# and r32, 0x1ffff  (81 /4 id), with or without a REX.B prefix.
_AND_INDEX = re.compile(rb"(?:\x41)?\x81[\xe0-\xe7]\xff\xff\x01\x00", re.S)
# shr r32, 13  (C1 /5 0d)
_SHR_13 = re.compile(rb"\xc1[\xe8-\xef]\x0d", re.S)
# test r32, 0x40000000  (F7 /0 id)
_TEST_FLAG_A = re.compile(rb"(?:\x41)?\xf7[\xc0-\xc7]\x00\x00\x00\x40", re.S)
# shr r32, 30 ; and r32, 1
_SHR_30_AND_1 = re.compile(rb"((?:\x41)?\xc1[\xe8-\xef])\x1e(?:\x41)?\x83[\xe0-\xe7]\x01", re.S)
# or / and dword [rsp+disp8], 0x20000
_OR_FLAG_A = re.compile(rb"\x81\x4c\x24(.)\x00\x00\x02\x00", re.S)
_AND_FLAG_A = re.compile(rb"\x81\x64\x24(.)\x00\x00\x02\x00", re.S)
# mov r32, 0x1fff ... shl r32, 13 ; or r32, r32 ; mov [r64], r32
_EMIT_SHIFT = re.compile(rb"\xff\x1f\x00\x00.{0,12}?\xc1([\xe0-\xe7])\x0d\x09.\x89", re.S)

_TABLE_DISPLACEMENT = bytes.fromhex("a8000000")  # [module + 0xa8]: the call-target table

INTERPRETER_INDEX_SITES = 5
DUMPER_INDEX_SITES = 1
INTERPRETER_FLAG_TESTS = 9
INTERPRETER_WINDOW = 0x8000

Edit = Tuple[int, bytes, bytes, str]


class PatchError(Exception):
    """The binary does not look like the build this patch was written for."""


def _index_sites(data: bytes) -> List[int]:
    """Offsets of the imm32 in every ``shr r,13 ; and r,0x1ffff ; [..+0xa8]`` decode."""
    sites = []
    for match in _AND_INDEX.finditer(data):
        start = match.start()
        if not _SHR_13.search(data, max(0, start - 12), start):
            continue
        if _TABLE_DISPLACEMENT not in data[match.end():match.end() + 48]:
            continue
        sites.append(match.end() - 4)
    return sites


def plan_edits(data: bytes) -> List[Edit]:
    """Return the in-place edits, or raise ``PatchError`` if anything is off."""
    edits: List[Edit] = []

    index_sites = _index_sites(data)
    expected_sites = INTERPRETER_INDEX_SITES + DUMPER_INDEX_SITES
    if len(index_sites) != expected_sites:
        raise PatchError(f"index decode sites: found {len(index_sites)}, expected {expected_sites}")
    for offset in index_sites:
        edits.append((offset, _INDEX_MASK_OLD, _INDEX_MASK_NEW, "index mask 17 -> 18 bits"))

    # The interpreter's five decodes sit together; the disassembly dumper's one is
    # far away. Flag tests are only rewritten inside the interpreter.
    ordered = sorted(index_sites)
    clusters = [[ordered[0]]]
    for offset in ordered[1:]:
        if offset - clusters[-1][-1] < 0x1000:
            clusters[-1].append(offset)
        else:
            clusters.append([offset])
    sizes = sorted(len(cluster) for cluster in clusters)
    if sizes != [DUMPER_INDEX_SITES, INTERPRETER_INDEX_SITES]:
        raise PatchError(f"index decode sites are grouped {sizes}, expected [1, 5]")
    interpreter = max(clusters, key=len)
    window_start = interpreter[0] - 0x100
    window_end = interpreter[0] + INTERPRETER_WINDOW

    tests = [m for m in _TEST_FLAG_A.finditer(data, window_start, window_end)]
    if len(tests) != INTERPRETER_FLAG_TESTS:
        raise PatchError(f"interpreter flag tests: found {len(tests)}, expected {INTERPRETER_FLAG_TESTS}")
    for match in tests:
        edits.append((match.end() - 4, _FLAG_A_WORD_OLD, _FLAG_A_WORD_NEW, "flag A test bit 30 -> bit 12"))

    shifts = [m for m in _SHR_30_AND_1.finditer(data, window_start, window_end)]
    if len(shifts) != 1:
        raise PatchError(f"interpreter flag extract (shr 30): found {len(shifts)}, expected 1")
    edits.append((shifts[0].start() + len(shifts[0].group(1)), b"\x1e", b"\x0c", "flag A extract bit 30 -> bit 12"))

    or_sites = list(_OR_FLAG_A.finditer(data))
    and_sites = list(_AND_FLAG_A.finditer(data))
    if len(or_sites) != 1 or len(and_sites) != 1:
        raise PatchError(f"compiler flag A sites: found or={len(or_sites)} and={len(and_sites)}, expected 1 and 1")
    or_site, and_site = or_sites[0], and_sites[0]
    if or_site.group(1) != and_site.group(1) or not 0 < and_site.start() - or_site.start() < 0x400:
        raise PatchError("compiler flag A sites do not belong to one function")
    edits.append((or_site.end() - 4, _FLAG_A_OPERAND_OLD, _FLAG_A_OPERAND_NEW, "compiler flag A bit 17 -> bit 31"))
    edits.append((and_site.end() - 4, _FLAG_A_OPERAND_OLD, _FLAG_A_OPERAND_NEW, "compiler flag A bit 17 -> bit 31"))

    emits = list(_EMIT_SHIFT.finditer(data, and_site.end(), and_site.end() + 0x400))
    if len(emits) != 1:
        raise PatchError(f"compiler emit shift: found {len(emits)}, expected 1")
    register = emits[0].group(1)[0] & 0x07
    shift_offset = emits[0].start(1)
    edits.append((shift_offset, bytes([0xE0 | register]), bytes([0xC0 | register]), "compiler shl 13 -> rol 13"))

    for offset, old, _new, label in edits:
        if data[offset:offset + len(old)] != old:
            raise PatchError(f"{label}: unexpected bytes at file offset {offset:#x}")
    return edits


def patch_bytes(data: bytes) -> bytes:
    patched = bytearray(data)
    for offset, _old, new, _label in plan_edits(data):
        patched[offset:offset + len(new)] = new
    return bytes(patched)


def patched_path_for(binary: str | os.PathLike) -> Path:
    binary = Path(binary)
    return binary.with_name(binary.name + PATCHED_SUFFIX)


def ensure_patched_binary(binary: str | os.PathLike) -> Path:
    """Write (or reuse) the patched copy next to ``binary`` and return its path.

    The copy is rebuilt whenever the stock binary changes, which is what a game
    update does. Raises ``PatchError`` when the patch does not fit.
    """
    binary = Path(binary)
    data = binary.read_bytes()
    target = patched_path_for(binary)
    stamp = target.with_name(target.name + ".source")
    source_id = f"{PATCH_VERSION}:{hashlib.sha256(data).hexdigest()}"
    if target.is_file() and stamp.is_file() and stamp.read_text().strip() == source_id:
        return target
    patched = patch_bytes(data)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_bytes(patched)
    os.chmod(temporary, 0o755)
    os.replace(temporary, target)
    stamp.write_text(source_id)
    return target


def main(argv: List[str]) -> int:
    if len(argv) not in (2, 3) or argv[1] in {"-h", "--help"}:
        print("usage: reforger_script_limit_patch.py <server binary> [--write]")
        return 2
    binary = Path(argv[1])
    data = binary.read_bytes()
    try:
        edits = plan_edits(data)
    except PatchError as exc:
        print(f"refused: {exc}")
        return 1
    for offset, old, new, label in sorted(edits):
        print(f"{offset:#010x}  {old.hex()} -> {new.hex()}  {label}")
    print(f"{len(edits)} edits fit {binary.name}")
    if len(argv) == 3 and argv[2] == "--write":
        print(f"wrote {ensure_patched_binary(binary)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
