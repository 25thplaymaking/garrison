import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

from services.server_player_sessions import parse_player_log_entry, parse_players_snapshot


def test_parse_player_connected_line():
    entry = {
        "timestamp": "2026-04-13T19:39:28.238+00:00",
        "line": "DEFAULT      : BattlEye Server: 'Player #0 Kestrel (203.0.113.77:52453) connected'",
        "raw": "19:39:28.238  DEFAULT      : BattlEye Server: 'Player #0 Kestrel (203.0.113.77:52453) connected'",
        "cursor": "console|1",
        "source": "console:console.log",
    }

    result = parse_player_log_entry(entry)

    assert result is not None
    assert result["event_type"] == "player_connected"
    assert result["player_slot"] == 0
    assert result["player_name"] == "Kestrel"
    assert result["endpoint"] == "203.0.113.77:52453"
    assert result["timestamp"] == datetime(2026, 4, 13, 19, 39, 28, 238000, tzinfo=timezone.utc)


def test_parse_player_guid_line():
    entry = {
        "timestamp": "2026-04-13T19:39:28.238+00:00",
        "line": "DEFAULT      : BattlEye Server: Setting GUID for player identity=0x00000000, GUID=76561190000000001",
        "raw": "19:39:28.238  DEFAULT      : BattlEye Server: Setting GUID for player identity=0x00000000, GUID=76561190000000001",
        "cursor": "console|2",
        "source": "console:console.log",
    }

    result = parse_player_log_entry(entry)

    assert result is not None
    assert result["event_type"] == "player_guid"
    assert result["player_identity"] == "0x00000000"
    assert result["player_guid"] == "76561190000000001"


def test_parse_player_be_guid_line():
    entry = {
        "timestamp": "2026-04-13T19:39:28.238+00:00",
        "line": "DEFAULT      : BattlEye Server: 'Player #0 Kestrel - BE GUID: 0123456789abcdef0123456789abcdef'",
        "raw": "19:39:28.238  DEFAULT      : BattlEye Server: 'Player #0 Kestrel - BE GUID: 0123456789abcdef0123456789abcdef'",
        "cursor": "console|3",
        "source": "console:console.log",
    }

    result = parse_player_log_entry(entry)

    assert result is not None
    assert result["event_type"] == "player_be_guid"
    assert result["player_slot"] == 0
    assert result["player_name"] == "Kestrel"
    assert result["player_be_guid"] == "0123456789abcdef0123456789abcdef"


def test_parse_player_disconnected_line_with_reason():
    entry = {
        "timestamp": "2026-04-13T20:11:10.000+00:00",
        "line": "DEFAULT      : BattlEye Server: 'Player #0 Kestrel (203.0.113.77:52453) disconnected (Client not responding)'",
        "raw": "20:11:10.000  DEFAULT      : BattlEye Server: 'Player #0 Kestrel (203.0.113.77:52453) disconnected (Client not responding)'",
        "cursor": "console|4",
        "source": "console:console.log",
    }

    result = parse_player_log_entry(entry)

    assert result is not None
    assert result["event_type"] == "player_disconnected"
    assert result["player_slot"] == 0
    assert result["player_name"] == "Kestrel"
    assert result["endpoint"] == "203.0.113.77:52453"
    assert result["disconnect_reason"] == "Client not responding"


def test_parse_players_snapshot_pipe_separated_rows():
    response = "\n".join(
        [
            "Players on server:",
            "0 | Kestrel | 68ms",
            "1 | AnotherPlayer | 42ms",
        ]
    )

    result = parse_players_snapshot(response)

    assert len(result) == 2
    assert result[0]["player_slot"] == 0
    assert result[0]["player_name"] == "Kestrel"
    assert result[0]["ping_ms"] == 68
    assert result[1]["player_slot"] == 1
    assert result[1]["player_name"] == "AnotherPlayer"


def test_parse_players_snapshot_reforger_rows():
    response = "\n".join(
        [
            "Players on server: [Player#] ; [Player UID] ; [Player Name]",
            "1 ; 1A2B3C4D-5E6F-4A1B-8C2D-3E4F5A6B7C8D ; Kestrel",
            "2 ; 0f3a1b2c-1111-2222-3333-444455556666 ; Second ; Name",
        ]
    )

    result = parse_players_snapshot(response)

    assert [(p["player_name"], p["player_uuid"]) for p in result] == [
        ("Kestrel", "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d"),
        ("Second ; Name", "0f3a1b2c-1111-2222-3333-444455556666"),
    ]
    assert result[0]["player_name_normalized"] == "kestrel"
    # The RCON player number is not the BattlEye slot the logs use, so it must not
    # overwrite a session's slot.
    assert all("player_slot" not in player for player in result)


def test_parse_players_snapshot_reforger_header_only_is_empty():
    assert parse_players_snapshot("Players on server: [Player#] ; [Player UID] ; [Player Name]") == []


def _snapshot_case(monkeypatch, a2s_reply):
    import asyncio
    import services.server_player_sessions as sessions

    calls = []

    async def fake_a2s(host, port):
        calls.append(("a2s", port))
        return a2s_reply

    async def fake_execute(host, port, password, command):
        calls.append(("rcon", command))
        return True, "Players on server: [Player#] ; [Player UID] ; [Player Name]\n1 ; 1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d ; Kestrel"

    monkeypatch.setattr(sessions, "query_a2s_info", fake_a2s)
    monkeypatch.setattr(sessions.bercon_client, "execute", fake_execute)
    server = {
        "id": "srv",
        "status": "running",
        "ports": {"query": 17777, "rcon": 19999},
        "config": {"rcon": {"password": "pw"}},
    }
    return asyncio.run(sessions._fetch_live_player_snapshot(server)), calls


def test_empty_server_snapshot_skips_rcon(monkeypatch):
    snapshot, calls = _snapshot_case(monkeypatch, {"player_count": 0})
    assert snapshot == []
    assert calls == [("a2s", 17777)]


def test_occupied_server_snapshot_uses_rcon(monkeypatch):
    snapshot, calls = _snapshot_case(monkeypatch, {"player_count": 1})
    assert [player["player_name"] for player in snapshot] == ["Kestrel"]
    assert calls == [("a2s", 17777), ("rcon", "#players")]


def test_snapshot_falls_back_to_rcon_when_a2s_is_unavailable(monkeypatch):
    snapshot, calls = _snapshot_case(monkeypatch, None)
    assert [player["player_name"] for player in snapshot] == ["Kestrel"]
    assert calls[-1] == ("rcon", "#players")


class _Cursor:
    def __init__(self, docs):
        self.docs = docs

    def sort(self, key, direction):
        self.docs.sort(key=lambda d: d.get(key), reverse=direction < 0)
        return self

    async def to_list(self, limit):
        return [dict(d) for d in self.docs[:limit]]


class _FakeSessions:
    def __init__(self):
        self.docs = []

    def find(self, query, projection=None):
        def matches(doc):
            for key, value in query.items():
                if isinstance(value, dict) and "$in" in value:
                    if not set(doc.get(key) or []) & set(value["$in"]):
                        return False
                elif doc.get(key) != value:
                    return False
            return True
        return _Cursor([d for d in self.docs if matches(d)])

    async def insert_one(self, doc):
        self.docs.append(dict(doc))

    async def update_one(self, query, update):
        for doc in self.docs:
            if all(doc.get(k) == v for k, v in query.items()):
                doc.update(update["$set"])
                return


def _reconcile_with_snapshots(monkeypatch, snapshots, clock):
    import asyncio
    from datetime import timedelta
    import services.server_player_sessions as sessions

    fake = _FakeSessions()

    class FakeDb:
        server_player_sessions = fake

    async def fake_snapshot(server):
        return snapshots.pop(0)

    monkeypatch.setattr(sessions, "db", FakeDb())
    monkeypatch.setattr(sessions, "_fetch_live_player_snapshot", fake_snapshot)
    monkeypatch.setattr(sessions, "_now", lambda: clock[0])
    server = {"id": "srv", "status": "running"}
    results = []
    while snapshots:
        results.append(asyncio.run(sessions.reconcile_server_player_snapshot(server)))
        clock[0] += timedelta(seconds=30)
    return fake, results


REFORGER_PLAYER = parse_players_snapshot(
    "Players on server: [Player#] ; [Player UID] ; [Player Name]\n"
    "1 ; 3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f ; Kestrel"
)


def test_repeated_snapshots_keep_one_session_per_player(monkeypatch):
    clock = [datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc)]
    fake, _ = _reconcile_with_snapshots(monkeypatch, [list(REFORGER_PLAYER) for _ in range(4)], clock)

    active = [d for d in fake.docs if d["active"]]
    assert len(fake.docs) == 1
    assert len(active) == 1
    assert active[0]["connected_at"] == datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc)


def test_existing_duplicate_sessions_are_closed_after_grace(monkeypatch):
    import asyncio
    import services.server_player_sessions as sessions

    clock = [datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc)]
    fake, _ = _reconcile_with_snapshots(monkeypatch, [list(REFORGER_PLAYER)], clock)
    # A second open session for the same player, as the slot bug used to create.
    stale = dict(fake.docs[0], id="playersess_dup", updated_at=clock[0] - timedelta(minutes=5),
                 last_seen_at=clock[0] - timedelta(minutes=5))
    fake.docs.append(stale)

    snapshots = [list(REFORGER_PLAYER)]

    async def fake_snapshot(server):
        return snapshots.pop(0)

    monkeypatch.setattr(sessions, "_fetch_live_player_snapshot", fake_snapshot)
    result = asyncio.run(sessions.reconcile_server_player_snapshot({"id": "srv", "status": "running"}))

    active = [d for d in fake.docs if d["active"]]
    assert len(active) == 1
    assert result["closed_sessions"] == 1
    closed = next(d for d in fake.docs if d["id"] == "playersess_dup")
    assert closed["disconnect_reason"] == "duplicate_session"


def test_player_absent_from_snapshot_is_closed_after_grace(monkeypatch):
    clock = [datetime(2026, 10, 13, 20, 0, tzinfo=timezone.utc)]
    fake, results = _reconcile_with_snapshots(monkeypatch, [list(REFORGER_PLAYER), [], []], clock)

    assert not [d for d in fake.docs if d["active"]]
    assert fake.docs[0]["disconnect_reason"] == "rcon_snapshot_absent"
    assert [r["closed_sessions"] for r in results] == [0, 0, 1]
