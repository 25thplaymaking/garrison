"""Tests for the loadout-wide dependency resolver
(servers.resolve_all_mod_dependencies).

Covers transitive resolution with provenance, skipping deps already present,
and cycle protection.
"""
import os
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest


def _fresh_ts():
    return datetime.now(timezone.utc).isoformat()

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "x" * 48)
os.environ.setdefault("JWT_ALGORITHM", "HS256")

import routes.servers as server_routes  # noqa: E402
from routes.servers import (  # noqa: E402
    resolve_all_mod_dependencies,
    resolve_mod_dependencies,
    ResolveAllDependenciesRequest,
    ResolveDependenciesRequest,
)


class _Workshop:
    def __init__(self, docs):
        self.by_id = {d["mod_id"]: d for d in docs}

    async def find_one(self, query, projection=None):
        return self.by_id.get(query.get("mod_id"))


class _Servers:
    def __init__(self, server):
        self.server = server

    async def find_one(self, query, projection=None):
        return self.server if query.get("id") == self.server["id"] else None


def _wire(monkeypatch, server, workshop_docs, fresh=None):
    """Wire a fake DB. By default the live-refresh path is stubbed to a no-op
    so resolution uses the provided stored records. Pass ``fresh`` (a dict
    mapping mod_id -> record, or an async callable) to simulate a live refetch.
    """
    monkeypatch.setattr(server_routes, "db", SimpleNamespace(
        managed_servers=_Servers(server),
        workshop_mods=_Workshop(workshop_docs),
    ))

    if callable(fresh):
        refresh_fn = fresh
    else:
        fresh_map = fresh or {}

        async def refresh_fn(mod_id):
            return fresh_map.get(mod_id)

    monkeypatch.setattr(server_routes, "_fetch_fresh_mod_record",
                        AsyncMock(side_effect=refresh_fn))


@pytest.mark.asyncio
async def test_resolve_all_collects_transitive_deps_with_provenance(monkeypatch):
    # A → B → C; loadout has only A, so B and C are missing additions.
    _wire(
        monkeypatch,
        {"id": "s1", "mods": [{"mod_id": "A", "name": "Alpha"}]},
        [
            {"mod_id": "A", "name": "Alpha", "dependencies": [{"mod_id": "B"}]},
            {"mod_id": "B", "name": "Bravo", "dependencies": [{"mod_id": "C"}]},
            {"mod_id": "C", "name": "Charlie", "dependencies": []},
        ],
    )
    with patch("services.workshop_ingest.fetch_and_store_mod", AsyncMock(return_value=None)):
        result = await resolve_all_mod_dependencies(
            "s1", ResolveAllDependenciesRequest(mod_ids=["A"]), current_user={"id": "u"}
        )

    by_id = {a["mod_id"]: a for a in result["additions"]}
    assert set(by_id) == {"B", "C"}
    assert by_id["B"]["dependency_of"] == ["A"]
    assert by_id["B"]["dependency_of_names"] == ["Alpha"]
    assert by_id["C"]["dependency_of"] == ["B"]
    assert result["provider_count"] == 1
    root = result["tree"][0]
    assert root["mod_id"] == "A" and root["already_present"] is True
    assert root["children"][0]["mod_id"] == "B"
    assert root["children"][0]["children"][0]["mod_id"] == "C"


@pytest.mark.asyncio
async def test_resolve_all_skips_deps_already_in_loadout(monkeypatch):
    _wire(
        monkeypatch,
        {"id": "s1", "mods": []},
        [
            {"mod_id": "A", "name": "Alpha", "dependencies": [{"mod_id": "B"}]},
            {"mod_id": "B", "name": "Bravo", "dependencies": []},
        ],
    )
    with patch("services.workshop_ingest.fetch_and_store_mod", AsyncMock(return_value=None)):
        result = await resolve_all_mod_dependencies(
            "s1", ResolveAllDependenciesRequest(mod_ids=["A", "B"]), current_user={"id": "u"}
        )
    assert result["addition_count"] == 0
    assert result["tree"][0]["children"][0]["already_present"] is True


@pytest.mark.asyncio
async def test_resolve_all_handles_cycles(monkeypatch):
    # A ↔ B cycle; resolver must not loop forever.
    _wire(
        monkeypatch,
        {"id": "s1", "mods": [{"mod_id": "A", "name": "Alpha"}]},
        [
            {"mod_id": "A", "name": "Alpha", "dependencies": [{"mod_id": "B"}]},
            {"mod_id": "B", "name": "Bravo", "dependencies": [{"mod_id": "A"}]},
        ],
    )
    with patch("services.workshop_ingest.fetch_and_store_mod", AsyncMock(return_value=None)):
        result = await resolve_all_mod_dependencies(
            "s1", ResolveAllDependenciesRequest(mod_ids=["A"]), current_user={"id": "u"}
        )
    assert {a["mod_id"] for a in result["additions"]} == {"B"}


@pytest.mark.asyncio
async def test_dep_named_by_parent_when_own_record_missing(monkeypatch):
    # B has no own record and the live refetch fails, but A's dependency list
    # names it — the resolver must surface that name, never the bare ID.
    _wire(
        monkeypatch,
        {"id": "s1", "mods": [{"mod_id": "A", "name": "Alpha"}]},
        [
            {"mod_id": "A", "name": "Alpha", "version": "1.0", "last_fetched": _fresh_ts(),
             "dependencies": [{"mod_id": "665C185384C8D370", "name": "Variable Belt Links", "version": "1.0.0"}]},
        ],
    )
    with patch("services.workshop_ingest.fetch_and_store_mod", AsyncMock(return_value=None)):
        result = await resolve_mod_dependencies(
            "s1", ResolveDependenciesRequest(mod_id="A"), current_user={"id": "u"}
        )
    dep = next(r for r in result["resolved"] if r["mod_id"] == "665C185384C8D370")
    assert dep["name"] == "Variable Belt Links"
    assert dep["metadata_available"] is False
    assert dep["required_version"] == "1.0.0"


@pytest.mark.asyncio
async def test_latest_version_comes_from_dep_own_record_not_parent(monkeypatch):
    # A declares it requires B 1.0, but B's own record is at 2.5 (latest).
    # ``version`` must be the latest (2.5); the declared baseline is exposed
    # separately as ``required_version`` (1.0).
    _wire(
        monkeypatch,
        {"id": "s1", "mods": [{"mod_id": "A", "name": "Alpha"}]},
        [
            {"mod_id": "A", "name": "Alpha", "version": "1.0", "last_fetched": _fresh_ts(),
             "dependencies": [{"mod_id": "B", "name": "Bravo", "version": "1.0"}]},
            {"mod_id": "B", "name": "Bravo", "version": "2.5", "last_fetched": _fresh_ts(),
             "dependencies": []},
        ],
    )
    with patch("services.workshop_ingest.fetch_and_store_mod", AsyncMock(return_value=None)):
        result = await resolve_mod_dependencies(
            "s1", ResolveDependenciesRequest(mod_id="A"), current_user={"id": "u"}
        )
    dep = next(r for r in result["resolved"] if r["mod_id"] == "B")
    assert dep["version"] == "2.5"
    assert dep["required_version"] == "1.0"


@pytest.mark.asyncio
async def test_resolve_all_refetches_fresh_looking_but_unverified_empty_deps(monkeypatch):
    # Regression: _sync_workshop_mod_metadata can persist a record that LOOKS
    # fresh (recent last_fetched, has name+version) yet carries empty,
    # never-actually-fetched dependencies. The resolver must NOT trust that
    # empty list — it has to refetch live, or it falsely reports the whole
    # loadout satisfied ("all dependencies fulfilled" false positive).
    fresh_a = {"mod_id": "A", "name": "Alpha", "version": "1.0",
               "dependencies": [{"mod_id": "B", "name": "Bravo"}],
               "dependencies_verified": True, "last_fetched": _fresh_ts()}
    _wire(
        monkeypatch,
        {"id": "s1", "mods": [{"mod_id": "A", "name": "Alpha"}]},
        [
            # Poisoned canonical record: fresh + named, but deps empty & unverified.
            {"mod_id": "A", "name": "Alpha", "version": "1.0",
             "dependencies": [], "last_fetched": _fresh_ts()},
            # B genuinely has no deps and IS verified — must not be refetched forever.
            {"mod_id": "B", "name": "Bravo", "version": "1.0", "dependencies": [],
             "dependencies_verified": True, "last_fetched": _fresh_ts()},
        ],
        fresh={"A": fresh_a},
    )
    with patch("services.workshop_ingest.fetch_and_store_mod", AsyncMock(return_value=None)):
        result = await resolve_all_mod_dependencies(
            "s1", ResolveAllDependenciesRequest(mod_ids=["A"]), current_user={"id": "u"}
        )
    assert {a["mod_id"] for a in result["additions"]} == {"B"}
    # A's empty deps were unverified → live refetch happened. B's were verified → not refetched.
    server_routes._fetch_fresh_mod_record.assert_awaited()


@pytest.mark.asyncio
async def test_partial_record_triggers_fresh_fetch(monkeypatch):
    # B is stored only as a partial (empty name/version) — resolution must
    # refetch the live page and use the enriched result.
    fresh_b = {"mod_id": "B", "name": "Bravo", "version": "3.0",
               "author": "Author", "dependencies": [], "last_fetched": _fresh_ts()}
    _wire(
        monkeypatch,
        {"id": "s1", "mods": [{"mod_id": "A", "name": "Alpha"}]},
        [
            {"mod_id": "A", "name": "Alpha", "version": "1.0", "last_fetched": _fresh_ts(),
             "dependencies": [{"mod_id": "B", "name": "Bravo", "version": "2.0"}]},
            {"mod_id": "B", "name": "", "version": "", "metadata_incomplete": True,
             "dependencies": []},
        ],
        fresh={"B": fresh_b},
    )
    with patch("services.workshop_ingest.fetch_and_store_mod", AsyncMock(return_value=None)):
        result = await resolve_mod_dependencies(
            "s1", ResolveDependenciesRequest(mod_id="A"), current_user={"id": "u"}
        )
    dep = next(r for r in result["resolved"] if r["mod_id"] == "B")
    assert dep["name"] == "Bravo"
    assert dep["version"] == "3.0"
    assert dep["metadata_available"] is True
    server_routes._fetch_fresh_mod_record.assert_awaited()
