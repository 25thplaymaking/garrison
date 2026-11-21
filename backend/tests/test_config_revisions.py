"""Tests for server config change history (services.config_revisions).

Covers the dotted-path diff that the history UI renders, and the off-by-one in
the old embedded format: an entry stored the config as it was BEFORE its own
change, so entry i's "after" is entry i+1's stored config and the newest entry's
"after" is the server's current config. Getting that wrong shifts every diff by
one revision.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "x" * 48)
os.environ.setdefault("JWT_ALGORITHM", "HS256")

from services.config_revisions import (  # noqa: E402
    flatten_config,
    summarize_config_diff,
)


# ── flatten_config ───────────────────────────────────────────────────────────

def test_flattens_nested_dicts_to_dotted_paths():
    flat = flatten_config({"game": {"gameProperties": {"serverMaxViewDistance": 2500}}})
    assert flat == {"game.gameProperties.serverMaxViewDistance": 2500}


def test_keeps_lists_whole_rather_than_indexing_them():
    # Indexing would report inserting at the front as a change to every element.
    flat = flatten_config({"game": {"admins": ["a", "b"]}})
    assert flat == {"game.admins": ["a", "b"]}


def test_summarises_the_mod_list_instead_of_expanding_it():
    # game.mods has its own revision history; 130 inlined entries would bury
    # whatever setting actually changed.
    flat = flatten_config({"game": {"mods": [{"modId": "A"}, {"modId": "B"}]}})
    assert flat == {"game.mods": "<2 entries>"}


def test_empty_nested_dict_is_still_reported_as_present():
    assert flatten_config({"game": {}}) == {"game": {}}


def test_non_dict_input_flattens_to_nothing():
    assert flatten_config([1, 2, 3]) == {}
    assert flatten_config(None) == {}


# ── summarize_config_diff ────────────────────────────────────────────────────

def test_detects_a_changed_scalar_with_from_and_to():
    diff = summarize_config_diff(
        {"game": {"gameProperties": {"serverMaxViewDistance": 2500}}},
        {"game": {"gameProperties": {"serverMaxViewDistance": 3000}}},
    )
    assert diff["changed"] == [
        {"path": "game.gameProperties.serverMaxViewDistance", "from": "2500", "to": "3000"}
    ]
    assert diff["total_changes"] == 1


def test_detects_added_and_removed_paths():
    diff = summarize_config_diff({"a": 1}, {"b": 2})
    assert diff["added"] == [{"path": "b", "value": "2"}]
    assert diff["removed"] == [{"path": "a", "value": "1"}]
    assert diff["total_changes"] == 2


def test_booleans_render_as_json_not_python():
    diff = summarize_config_diff(
        {"game": {"gameProperties": {"disableThirdPerson": False}}},
        {"game": {"gameProperties": {"disableThirdPerson": True}}},
    )
    assert diff["changed"][0]["from"] == "false"
    assert diff["changed"][0]["to"] == "true"


def test_identical_configs_produce_no_changes():
    config = {"game": {"name": "Server 1", "gameProperties": {"x": 1}}}
    diff = summarize_config_diff(config, dict(config))
    assert diff["total_changes"] == 0
    assert diff["added"] == diff["removed"] == diff["changed"] == []


def test_a_mod_count_change_is_reported_without_listing_mods():
    diff = summarize_config_diff(
        {"game": {"mods": [{"modId": "A"}]}},
        {"game": {"mods": [{"modId": "A"}, {"modId": "B"}]}},
    )
    assert diff["changed"] == [{"path": "game.mods", "from": "<1 entries>", "to": "<2 entries>"}]


def test_long_values_are_truncated_for_display():
    diff = summarize_config_diff({"a": "x"}, {"a": "y" * 500})
    assert diff["changed"][0]["to"].endswith("…")
    assert len(diff["changed"][0]["to"]) <= 301


def test_list_contents_changing_is_detected():
    diff = summarize_config_diff({"game": {"admins": ["a"]}}, {"game": {"admins": ["a", "b"]}})
    assert diff["changed"][0]["path"] == "game.admins"


def test_paths_are_sorted_so_diffs_read_consistently():
    diff = summarize_config_diff({}, {"z": 1, "a": 1, "m": 1})
    assert [entry["path"] for entry in diff["added"]] == ["a", "m", "z"]


def test_null_configs_are_tolerated():
    assert summarize_config_diff(None, None)["total_changes"] == 0
    assert summarize_config_diff(None, {"a": 1})["added"] == [{"path": "a", "value": "1"}]


# ── migrate_embedded_history ─────────────────────────────────────────────────

class _FakeCollection:
    def __init__(self):
        self.upserts = []

    async def update_one(self, filt, update, upsert=False):
        self.upserts.append(update.get("$setOnInsert") or {})


class _FakeDb:
    def __init__(self):
        self.revisions = _FakeCollection()

    def __getitem__(self, name):
        return self.revisions


@pytest.mark.asyncio
async def test_migration_pairs_each_entry_with_the_NEXT_entrys_config(monkeypatch):
    # An embedded entry holds the PRE-change config. So v1's "after" is v2's
    # stored config, and the newest entry's "after" is the live config.
    from services import config_revisions

    fake = _FakeDb()
    monkeypatch.setattr(config_revisions, "db", fake)

    server = {
        "id": "s1",
        "config": {"v": 3},
        "config_history": [
            {"version": 1, "config": {"v": 1}, "changed_by": "u1", "changed_at": "t1"},
            {"version": 2, "config": {"v": 2}, "changed_by": "u2", "changed_at": "t2"},
        ],
    }
    moved = await config_revisions.migrate_embedded_history(server)

    assert moved == 2
    first, second = fake.revisions.upserts
    assert first["version"] == 1
    assert first["before_config"] == {"v": 1} and first["after_config"] == {"v": 2}
    assert second["version"] == 2
    # Newest entry pairs against the server's CURRENT config.
    assert second["before_config"] == {"v": 2} and second["after_config"] == {"v": 3}


@pytest.mark.asyncio
async def test_migration_sorts_out_of_order_entries(monkeypatch):
    from services import config_revisions

    fake = _FakeDb()
    monkeypatch.setattr(config_revisions, "db", fake)

    server = {
        "id": "s1",
        "config": {"v": 3},
        "config_history": [
            {"version": 2, "config": {"v": 2}},
            {"version": 1, "config": {"v": 1}},
        ],
    }
    await config_revisions.migrate_embedded_history(server)
    assert [u["version"] for u in fake.revisions.upserts] == [1, 2]


@pytest.mark.asyncio
async def test_migration_skips_entries_that_changed_nothing(monkeypatch):
    from services import config_revisions

    fake = _FakeDb()
    monkeypatch.setattr(config_revisions, "db", fake)

    server = {
        "id": "s1",
        "config": {"v": 1},
        "config_history": [{"version": 1, "config": {"v": 1}}],
    }
    assert await config_revisions.migrate_embedded_history(server) == 0
    assert fake.revisions.upserts == []


@pytest.mark.asyncio
async def test_migration_of_an_empty_history_is_a_noop(monkeypatch):
    from services import config_revisions

    monkeypatch.setattr(config_revisions, "db", _FakeDb())
    assert await config_revisions.migrate_embedded_history({"id": "s1"}) == 0
