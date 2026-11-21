"""An in-memory stand-in for Mongo, for personnel flows that touch many collections.

Covers the operators those flows use: equality (lists match on any item), dotted
paths (also into arrays of documents), ``$in``, ``$nin``, ``$ne``, ``$lt``, ``$lte``, ``$gte``,
``$type``, ``$regex``, ``$elemMatch``, ``$exists``, ``$or``, updates with ``$set`` (including the
positional ``array.$.field``), ``$unset``, ``$inc``, ``$pull`` (a value or a query), ``$push`` (and
``$each``) and upsert with ``$setOnInsert``,
``find_one_and_update``, and unique keys.
"""
from __future__ import annotations

import copy
import re
from typing import Any, Dict, List, Optional, Sequence
from unittest.mock import MagicMock

from pymongo.errors import DuplicateKeyError


def _value(doc: Dict[str, Any], path: str) -> Any:
    current: Any = doc
    for part in path.split("."):
        if isinstance(current, list) and not part.isdigit():
            # ``comments.id`` reads every element's ``id``, as Mongo does.
            current = [item.get(part) for item in current if isinstance(item, dict) and part in item]
            continue
        if isinstance(current, list):
            index = int(part)
            current = current[index] if index < len(current) else None
            continue
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def _op_matches(value: Any, op: str, wanted: Any, spec: Dict[str, Any]) -> bool:
    if op == "$elemMatch":
        return isinstance(value, list) and any(isinstance(item, dict) and matches(item, wanted) for item in value)
    values = value if isinstance(value, list) else [value]
    if op == "$in":
        return any(v in wanted for v in values)
    if op == "$nin":
        return not any(v in wanted for v in values)
    if op == "$ne":
        return wanted not in values
    if op == "$lt":
        return value is not None and value < wanted
    if op == "$lte":
        return value is not None and value <= wanted
    if op == "$gte":
        return value is not None and value >= wanted
    if op == "$type":
        return isinstance(value, str) if wanted == "string" else value is not None
    if op == "$regex":
        flags = re.IGNORECASE if "i" in str(spec.get("$options") or "") else 0
        return value is not None and re.search(wanted, str(value), flags) is not None
    if op == "$options":
        return True
    if op == "$exists":
        return (value is not None) == bool(wanted)
    raise AssertionError(f"memory_db has no {op}")


def matches(doc: Dict[str, Any], query: Dict[str, Any]) -> bool:
    for key, wanted in query.items():
        if key == "$or":
            if not any(matches(doc, branch) for branch in wanted):
                return False
            continue
        value = _value(doc, key)
        if isinstance(wanted, dict) and any(str(k).startswith("$") for k in wanted):
            if not all(_op_matches(value, op, arg, wanted) for op, arg in wanted.items()):
                return False
        elif isinstance(value, list):
            if wanted not in value:
                return False
        elif value != wanted:
            return False
    return True


def _set(doc: Dict[str, Any], path: str, value: Any) -> None:
    parts = path.split(".")
    for part in parts[:-1]:
        doc = doc[int(part)] if isinstance(doc, list) else doc.setdefault(part, {})
    if isinstance(doc, list):
        doc[int(parts[-1])] = value
    else:
        doc[parts[-1]] = value


def _positional(row: Dict[str, Any], path: str, query: Dict[str, Any]) -> str:
    """``comments.$.text`` -> ``comments.3.text``: the first element the query matched."""
    if ".$" not in path:
        return path
    array, rest = path.split(".$", 1)
    items = _value(row, array) or []
    conditions = {key[len(array) + 1:]: wanted for key, wanted in query.items() if key.startswith(f"{array}.")}
    elem = query.get(array, {}).get("$elemMatch") if isinstance(query.get(array), dict) else None
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        if elem is not None and not matches(item, elem):
            continue
        if conditions and not matches(item, conditions):
            continue
        return f"{array}.{index}{rest}"
    raise AssertionError(f"memory_db: positional {path} matched no element")


def _unset(doc: Dict[str, Any], path: str) -> None:
    parts = path.split(".")
    for part in parts[:-1]:
        doc = doc.get(part) or {}
    doc.pop(parts[-1], None)


class _Cursor:
    def __init__(self, rows: List[Dict[str, Any]]):
        self.rows = rows

    def sort(self, key: Any, direction: int = 1) -> "_Cursor":
        pairs = key if isinstance(key, list) else [(key, direction)]
        for field, order in reversed(pairs):
            self.rows.sort(key=lambda row: str(_value(row, field) or ""), reverse=order < 0)
        return self

    def skip(self, count: int) -> "_Cursor":
        self.rows = self.rows[count:]
        return self

    def limit(self, count: int) -> "_Cursor":
        self.rows = self.rows[:count] if count else self.rows
        return self

    async def to_list(self, length: Optional[int] = None) -> List[Dict[str, Any]]:
        return copy.deepcopy(self.rows if length is None else self.rows[:length])


class MemoryCollection:
    def __init__(self, rows: Sequence[Dict[str, Any]] = (), unique: Sequence[Sequence[str]] = ()):
        self.rows: List[Dict[str, Any]] = [copy.deepcopy(dict(row)) for row in rows]
        self.unique = [tuple(keys) for keys in unique]

    def _check_unique(self, doc: Dict[str, Any]) -> None:
        if "_id" in doc and any(row.get("_id") == doc["_id"] for row in self.rows):
            raise DuplicateKeyError("_id")
        for keys in self.unique:
            if all(doc.get(key) is not None for key in keys) and any(
                    all(row.get(key) == doc.get(key) for key in keys) for row in self.rows):
                raise DuplicateKeyError(str(keys))

    async def insert_one(self, doc: Dict[str, Any]) -> MagicMock:
        self._check_unique(doc)
        self.rows.append(copy.deepcopy(doc))
        return MagicMock(inserted_id=doc.get("id"))

    def find(self, query: Optional[Dict[str, Any]] = None, _projection: Any = None) -> _Cursor:
        return _Cursor([copy.deepcopy(row) for row in self.rows if matches(row, query or {})])

    async def find_one(self, query: Optional[Dict[str, Any]] = None, _projection: Any = None, sort: Any = None):
        rows = await self.find(query or {}).sort(sort or "_", 1).to_list() if sort else await self.find(query or {}).to_list()
        return rows[0] if rows else None

    async def count_documents(self, query: Optional[Dict[str, Any]] = None) -> int:
        return len([row for row in self.rows if matches(row, query or {})])

    def _apply(self, row: Dict[str, Any], update: Dict[str, Any], query: Optional[Dict[str, Any]] = None) -> None:
        for path, value in (update.get("$set") or {}).items():
            _set(row, _positional(row, path, query or {}), copy.deepcopy(value))
        for path in update.get("$unset") or {}:
            _unset(row, path)
        for path, amount in (update.get("$inc") or {}).items():
            _set(row, path, (_value(row, path) or 0) + amount)
        for path, value in (update.get("$pull") or {}).items():
            current = _value(row, path) or []
            if isinstance(value, dict) and not any(str(k).startswith("$") for k in value):
                # ``{"$pull": {"items": {"id": "x"}}}`` removes the elements matching that query.
                _set(row, path, [item for item in current if not (isinstance(item, dict) and matches(item, value))])
            else:
                _set(row, path, [item for item in current if item != value])
        for path, value in (update.get("$push") or {}).items():
            current = _value(row, path) or []
            items = value["$each"] if isinstance(value, dict) and "$each" in value else [value]
            _set(row, path, [*current, *copy.deepcopy(items)])

    async def update_one(self, query: Dict[str, Any], update: Dict[str, Any], upsert: bool = False) -> MagicMock:
        for row in self.rows:
            if matches(row, query):
                before = copy.deepcopy(row)
                self._apply(row, update, query)
                return MagicMock(matched_count=1, modified_count=int(before != row), upserted_id=None)
        if upsert:
            row = {key: value for key, value in query.items() if not str(key).startswith("$")}
            for path, value in (update.get("$setOnInsert") or {}).items():
                _set(row, path, copy.deepcopy(value))
            self._apply(row, update)
            self.rows.append(row)
            return MagicMock(matched_count=0, modified_count=0, upserted_id=row.get("id"))
        return MagicMock(matched_count=0, modified_count=0, upserted_id=None)

    async def find_one_and_update(self, query: Dict[str, Any], update: Dict[str, Any], upsert: bool = False,
                                  return_document: Any = False, **_ignored: Any):
        """``return_document`` is pymongo's ``ReturnDocument``: True means AFTER (the
        updated document itself, even when the update means the query no longer matches it)."""
        row = next((row for row in self.rows if matches(row, query)), None)
        if row is None:
            if not upsert:
                return None
            await self.update_one(query, update, upsert=True)
            return await self.find_one({k: v for k, v in query.items() if not str(k).startswith("$")})                 if return_document else None
        before = copy.deepcopy(row)
        self._apply(row, update, query)
        return copy.deepcopy(row) if return_document else before

    async def update_many(self, query: Dict[str, Any], update: Dict[str, Any]) -> MagicMock:
        hits = [row for row in self.rows if matches(row, query)]
        for row in hits:
            self._apply(row, update)
        return MagicMock(matched_count=len(hits), modified_count=len(hits))

    async def delete_one(self, query: Dict[str, Any]) -> MagicMock:
        for index, row in enumerate(self.rows):
            if matches(row, query):
                del self.rows[index]
                return MagicMock(deleted_count=1)
        return MagicMock(deleted_count=0)

    async def delete_many(self, query: Dict[str, Any]) -> MagicMock:
        before = len(self.rows)
        self.rows = [row for row in self.rows if not matches(row, query)]
        return MagicMock(deleted_count=before - len(self.rows))


class MemoryDb:
    """Collections appear on first use, empty."""

    def __init__(self, **collections: Sequence[Dict[str, Any]]):
        self._collections: Dict[str, MemoryCollection] = {
            name: MemoryCollection(rows) for name, rows in collections.items()}

    def __getattr__(self, name: str) -> MemoryCollection:
        if name.startswith("_"):
            raise AttributeError(name)
        return self._collections.setdefault(name, MemoryCollection())

    def __getitem__(self, name: str) -> MemoryCollection:
        return getattr(self, name)
