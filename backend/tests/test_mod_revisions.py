"""Tests for the mod-loadout changelog diff (servers._summarize_mod_diff).

This is what the revision history renders, so the add/remove/version/reorder
detection needs to be accurate and noise-free.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")
os.environ.setdefault("JWT_SECRET", "x" * 48)
os.environ.setdefault("JWT_ALGORITHM", "HS256")

from routes.servers import _summarize_mod_diff  # noqa: E402


def _mod(mod_id, name=None, version="", enabled=True):
    return {"mod_id": mod_id, "name": name or mod_id, "version": version, "enabled": enabled}


def test_diff_detects_added_and_removed():
    before = [_mod("A", "Alpha"), _mod("B", "Bravo")]
    after = [_mod("A", "Alpha"), _mod("C", "Charlie")]
    diff = _summarize_mod_diff(before, after)
    assert [m["mod_id"] for m in diff["added"]] == ["C"]
    assert [m["mod_id"] for m in diff["removed"]] == ["B"]
    assert diff["added_count"] == 1 and diff["removed_count"] == 1
    assert diff["reordered"] is False


def test_diff_detects_version_change():
    before = [_mod("A", "Alpha", version="1.0")]
    after = [_mod("A", "Alpha", version="2.0")]
    diff = _summarize_mod_diff(before, after)
    assert diff["version_changed"] == [{"mod_id": "A", "name": "Alpha", "from": "1.0", "to": "2.0"}]
    assert diff["added"] == [] and diff["removed"] == []


def test_diff_detects_enabled_toggle():
    before = [_mod("A", "Alpha", enabled=True)]
    after = [_mod("A", "Alpha", enabled=False)]
    diff = _summarize_mod_diff(before, after)
    assert diff["enabled_changed"] == [{"mod_id": "A", "name": "Alpha", "enabled": False}]


def test_diff_detects_reorder_only():
    before = [_mod("A"), _mod("B"), _mod("C")]
    after = [_mod("C"), _mod("A"), _mod("B")]
    diff = _summarize_mod_diff(before, after)
    assert diff["reordered"] is True
    assert diff["added"] == [] and diff["removed"] == []


def test_diff_identical_is_noop():
    mods = [_mod("A", "Alpha", version="1.0"), _mod("B", "Bravo")]
    diff = _summarize_mod_diff(mods, [dict(m) for m in mods])
    assert not any([
        diff["added"], diff["removed"], diff["version_changed"],
        diff["enabled_changed"], diff["reordered"],
    ])


def test_diff_reorder_ignores_added_removed_positions():
    # Adding C at the front shouldn't be miscounted as a reorder of A/B.
    before = [_mod("A"), _mod("B")]
    after = [_mod("C"), _mod("A"), _mod("B")]
    diff = _summarize_mod_diff(before, after)
    assert [m["mod_id"] for m in diff["added"]] == ["C"]
    assert diff["reordered"] is False


# ── Reorder detail (_detect_moves) ───────────────────────────────────────────
# `reordered: True` alone never told anyone WHAT moved. These cover the
# minimal-move reporting that replaced it.

def test_moving_one_mod_to_the_front_names_only_that_mod():
    # Naive index comparison would report all four as moved, since everything
    # behind D shifts down one. Only D actually moved.
    before = [_mod("A"), _mod("B"), _mod("C"), _mod("D")]
    after = [_mod("D"), _mod("A"), _mod("B"), _mod("C")]
    diff = _summarize_mod_diff(before, after)
    assert diff["reordered"] is True
    assert [m["mod_id"] for m in diff["moved"]] == ["D"]
    assert diff["moved_count"] == 1


def test_move_reports_one_based_positions_in_the_full_list():
    before = [_mod("A"), _mod("B"), _mod("C"), _mod("D")]
    after = [_mod("D"), _mod("A"), _mod("B"), _mod("C")]
    moved = _summarize_mod_diff(before, after)["moved"][0]
    assert moved["from"] == 4 and moved["to"] == 1


def test_move_carries_the_display_name():
    before = [_mod("A", "Alpha"), _mod("Z", "Zulu")]
    after = [_mod("Z", "Zulu"), _mod("A", "Alpha")]
    assert _summarize_mod_diff(before, after)["moved"][0]["name"] in {"Zulu", "Alpha"}


def test_identical_order_reports_no_moves():
    mods = [_mod("A"), _mod("B"), _mod("C")]
    diff = _summarize_mod_diff(mods, [dict(m) for m in mods])
    assert diff["moved"] == []
    assert diff["moved_count"] == 0


def test_pure_addition_is_not_reported_as_a_move():
    # Inserting C at the front shifts A and B but moves neither.
    before = [_mod("A"), _mod("B")]
    after = [_mod("C"), _mod("A"), _mod("B")]
    diff = _summarize_mod_diff(before, after)
    assert diff["moved"] == []
    assert diff["reordered"] is False


def test_removal_alone_is_not_reported_as_a_move():
    before = [_mod("A"), _mod("B"), _mod("C")]
    after = [_mod("A"), _mod("C")]
    diff = _summarize_mod_diff(before, after)
    assert diff["moved"] == []


def test_a_swap_names_a_minimal_set():
    # Swapping two neighbours is explainable as moving just one of them.
    before = [_mod("A"), _mod("B"), _mod("C")]
    after = [_mod("B"), _mod("A"), _mod("C")]
    diff = _summarize_mod_diff(before, after)
    assert diff["moved_count"] == 1
    assert diff["moved"][0]["mod_id"] in {"A", "B"}


def test_full_reversal_is_reported_without_naming_everything():
    before = [_mod(c) for c in "ABCDE"]
    after = [_mod(c) for c in "EDCBA"]
    diff = _summarize_mod_diff(before, after)
    assert diff["reordered"] is True
    # A reversal keeps an LCS of length 1, so it cannot be under 4 moves.
    assert diff["moved_count"] == 4


def test_moves_are_computed_alongside_adds_and_removes():
    before = [_mod("A"), _mod("B"), _mod("C")]
    after = [_mod("C"), _mod("A"), _mod("D")]
    diff = _summarize_mod_diff(before, after)
    assert [m["mod_id"] for m in diff["added"]] == ["D"]
    assert [m["mod_id"] for m in diff["removed"]] == ["B"]
    # A and C swapped relative order; naming either one explains it, so assert
    # the move count rather than which of the pair the LCS happened to keep.
    assert diff["moved_count"] == 1
    assert diff["moved"][0]["mod_id"] in {"A", "C"}


def test_moves_ignore_mods_that_are_not_in_both_lists():
    before = [_mod("A"), _mod("B")]
    after = [_mod("B")]
    assert _summarize_mod_diff(before, after)["moved"] == []
