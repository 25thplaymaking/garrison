"""What each downloaded Workshop addon ships, read straight from its files.

A Reforger crash names a resource (``scripts/Game/.../Foo.c``, a prefab, a
config) but never the mod that owns it. Every addon folder under
``workshop/addons/<Name>_<GUID>/`` holds one or more ``.pak`` archives whose
``FILE`` chunk is a directory tree of everything inside, so the owner of any
path can be found without unpacking. ``addon.gproj`` (or ``dev.gproj``)
lists the addon's dependencies, which tells us which listed mods would break
if a culprit were removed.

Pak layout (big-endian chunk sizes)::

    FORM <u32 size> PAC1
    HEAD <u32 size> ...
    DATA <u32 size> ...          # file contents, skipped
    FILE <u32 size> <tree>

``<tree>`` is a pre-order walk of entries: ``u8 kind`` (0 dir, 1 file),
``u8 name_len``, ``name``; a dir then holds ``u32le child_count`` and a file
24 bytes of offset/size/timestamp metadata.
"""

from __future__ import annotations

import json
import logging
import re
import struct
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

logger = logging.getLogger(__name__)

_GUID_FOLDER_RE = re.compile(r"_([0-9A-Fa-f]{16})$")
_GPROJ_DEPENDENCIES_RE = re.compile(r"Dependencies\s*\{([^}]*)\}", re.DOTALL)
_GPROJ_GUID_RE = re.compile(r'"([0-9A-Fa-f]{16})"')
_GPROJ_TITLE_RE = re.compile(r'^\s*TITLE\s+"([^"]*)"', re.MULTILINE)
_FILE_RECORD_BYTES = 24
_MAX_FILE_CHUNK_BYTES = 64 * 1024 * 1024
# Base-game GUIDs every addon depends on; never a culprit or a dependent.
BASE_GAME_GUIDS = frozenset({"58D0FB3206B6F859", "5614BBCCBB55ED1C"})


def guid_from_folder(name: str) -> Optional[str]:
    match = _GUID_FOLDER_RE.search(name or "")
    return match.group(1).upper() if match else None


def read_pak_paths(pak_path: Path) -> List[str]:
    """Return every file path stored in one ``.pak``; [] when unreadable."""
    try:
        with open(pak_path, "rb") as handle:
            header = handle.read(12)
            if len(header) < 12 or header[:4] != b"FORM" or header[8:12] != b"PAC1":
                return []
            while True:
                chunk = handle.read(8)
                if len(chunk) < 8:
                    return []
                tag, size = chunk[:4], struct.unpack(">I", chunk[4:])[0]
                if tag != b"FILE":
                    handle.seek(size, 1)
                    continue
                if size > _MAX_FILE_CHUNK_BYTES:
                    return []
                return _walk_file_tree(handle.read(size))
    except OSError as exc:
        logger.debug("pak index: cannot read %s: %s", pak_path, exc)
        return []


def _walk_file_tree(data: bytes) -> List[str]:
    paths: List[str] = []
    pos = 0

    def walk(prefix: str, depth: int) -> None:
        nonlocal pos
        kind, name_len = data[pos], data[pos + 1]
        name = data[pos + 2:pos + 2 + name_len].decode("utf-8", "replace")
        pos += 2 + name_len
        full = f"{prefix}/{name}" if prefix else name
        if kind != 0:
            pos += _FILE_RECORD_BYTES
            paths.append(full)
            return
        count = struct.unpack_from("<I", data, pos)[0]
        pos += 4
        if depth > 64:
            raise ValueError("pak tree too deep")
        for _ in range(count):
            walk(full, depth + 1)

    try:
        walk("", 0)
    except (IndexError, struct.error, ValueError):
        pass
    return paths


def read_addon_meta(addon_dir: Path) -> Dict[str, Any]:
    """Name and installed version from the addon's ``meta`` (UTF-8 BOM JSON)."""
    try:
        raw = json.loads((addon_dir / "meta").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    meta = raw.get("meta") if isinstance(raw, dict) else None
    if not isinstance(meta, dict):
        return {}
    versions = meta.get("versions") or []
    version = versions[0].get("version") if versions and isinstance(versions[0], dict) else None
    return {
        "name": meta.get("name"),
        "version": version,
        "updated_at": meta.get("updatedAt"),
    }


def read_addon_dependencies(addon_dir: Path) -> List[str]:
    """Dependency GUIDs declared by the addon's gproj (base game excluded)."""
    for gproj in sorted(addon_dir.glob("*.gproj")):
        try:
            text = gproj.read_text(encoding="utf-8-sig", errors="replace")
        except OSError:
            continue
        match = _GPROJ_DEPENDENCIES_RE.search(text)
        if not match:
            return []
        return [
            guid.upper()
            for guid in _GPROJ_GUID_RE.findall(match.group(1))
            if guid.upper() not in BASE_GAME_GUIDS
        ]
    return []


def list_addons(addons_dir: Path) -> Dict[str, Dict[str, Any]]:
    """GUID -> {folder, name, version, dependencies} for every downloaded addon."""
    addons: Dict[str, Dict[str, Any]] = {}
    try:
        entries = sorted(p for p in addons_dir.iterdir() if p.is_dir())
    except OSError:
        return addons
    for entry in entries:
        guid = guid_from_folder(entry.name)
        if not guid:
            continue
        meta = read_addon_meta(entry)
        addons[guid] = {
            "mod_id": guid,
            "folder": entry.name,
            "name": meta.get("name") or entry.name.rsplit("_", 1)[0],
            "version": meta.get("version"),
            "updated_at": meta.get("updated_at"),
            "dependencies": read_addon_dependencies(entry),
        }
    return addons


def find_resource_owners(addons_dir: Path, resource_paths: Iterable[str]) -> Dict[str, List[Dict[str, Any]]]:
    """Map each resource path to the addons whose paks contain it.

    Matching is case-insensitive (the engine logs ``scripts/`` and
    ``Scripts/`` interchangeably), but an exact-case hit is flagged: when two
    addons ship the same path, the engine's spelling names the one it used.
    """
    wanted: Dict[str, str] = {}
    for raw in resource_paths:
        normalized = _normalize_resource(raw)
        if normalized:
            wanted[normalized.lower()] = normalized
    owners: Dict[str, List[Dict[str, Any]]] = {path: [] for path in wanted.values()}
    if not wanted:
        return owners
    try:
        entries = sorted(p for p in addons_dir.iterdir() if p.is_dir())
    except OSError:
        return owners
    for entry in entries:
        guid = guid_from_folder(entry.name)
        if not guid:
            continue
        for pak in sorted(entry.glob("*.pak")):
            for stored in read_pak_paths(pak):
                key = stored.lower()
                if key not in wanted:
                    continue
                requested = wanted[key]
                if any(o["mod_id"] == guid for o in owners[requested]):
                    continue
                owners[requested].append({
                    "mod_id": guid,
                    "folder": entry.name,
                    "stored_path": stored,
                    "exact_case": stored == requested,
                })
    return owners


def _normalize_resource(raw: str) -> str:
    value = (raw or "").strip().strip('"').strip("@").strip('"')
    # Drop a leading resource GUID: "{50B284DDBAFA7C00}Prefabs/..."
    if value.startswith("{") and "}" in value:
        value = value.split("}", 1)[1]
    return value.lstrip("/")


# --- Script budget --------------------------------------------------------
# Hosting panels rank a server's mods by how many script files (``.c``) each
# one ships. The engine loads the mod list plus every dependency it pulls in
# (not every folder on disk: leftovers stay unloaded), so that set is what is
# counted here. Counts are cached per pak by size and mtime.

_SCRIPT_COUNT_CACHE: Dict[str, tuple] = {}


def count_scripts(addon_dir: Path) -> int:
    """Number of ``.c`` script files across every ``.pak`` of one addon."""
    total = 0
    for pak in sorted(addon_dir.glob("*.pak")):
        try:
            stat = pak.stat()
        except OSError:
            continue
        key = str(pak)
        signature = (stat.st_size, int(stat.st_mtime))
        cached = _SCRIPT_COUNT_CACHE.get(key)
        if cached and cached[0] == signature:
            total += cached[1]
            continue
        count = sum(1 for path in read_pak_paths(pak) if path.lower().endswith(".c"))
        _SCRIPT_COUNT_CACHE[key] = (signature, count)
        total += count
    return total


def _closure(roots: Iterable[str], addons: Dict[str, Dict[str, Any]]) -> set:
    seen: set = set()
    stack = list(roots)
    while stack:
        guid = stack.pop()
        if guid in seen:
            continue
        seen.add(guid)
        stack.extend(addons.get(guid, {}).get("dependencies") or [])
    return seen


def script_budget(addons_dir: Optional[Path], listed_ids: Iterable[str],
                  listed_names: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Script files each loaded mod owns, and what taking it off would free.

    ``own`` is the mod's own ``.c`` count. ``frees`` is everything that stops
    loading if the mod comes off the list: the mod itself, the listed mods
    that need it (they cannot stay without it) and every dependency no
    remaining mod still needs.
    """
    listed_names = listed_names or {}
    listed: List[str] = []
    for raw in listed_ids:
        guid = str(raw or "").upper()
        if guid and guid not in BASE_GAME_GUIDS and guid not in listed:
            listed.append(guid)
    addons = list_addons(addons_dir) if addons_dir and addons_dir.is_dir() else {}
    per_root = {root: _closure([root], addons) for root in listed}
    loaded = set().union(*per_root.values()) if per_root else set()
    loaded -= BASE_GAME_GUIDS
    counts = {
        guid: count_scripts(addons_dir / addons[guid]["folder"])
        for guid in loaded if guid in addons
    }
    listed_set = set(listed)

    def name_of(guid: str) -> str:
        return addons.get(guid, {}).get("name") or listed_names.get(guid) or guid

    rows = []
    for guid in loaded:
        needing = [root for root in listed if guid in per_root[root]]
        remaining = set()
        for root in listed:
            if root not in needing:
                remaining |= per_root[root]
        freed = loaded - remaining
        rows.append({
            "mod_id": guid,
            "name": name_of(guid),
            "version": addons.get(guid, {}).get("version"),
            "listed": guid in listed_set,
            "downloaded": guid in addons,
            "own": counts.get(guid, 0),
            "frees": sum(counts.get(other, 0) for other in freed),
            "frees_mods": len(freed),
            "needed_by": [
                {"mod_id": root, "name": name_of(root)}
                for root in needing if root != guid
            ],
        })
    rows.sort(key=lambda row: (-row["own"], -row["frees"], row["name"].lower()))
    total = sum(counts.values())
    return {
        "mods": rows,
        "total_scripts": total,
        "loaded_count": len(loaded),
        "listed_count": len(listed),
        "dependency_count": len(loaded - listed_set),
        "missing_count": sum(1 for guid in loaded if guid not in addons),
    }
