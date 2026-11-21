"""Compare / Mirror's public server list (ReforgerMods), which replaced BattleMetrics."""
import asyncio
import os
import sys

import httpx
import pytest
from fastapi import HTTPException

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from routes import servers as servers_route  # noqa: E402

USER = {"id": "u1", "role": "admin"}
SERVER_ID = "4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a"
DETAIL = {
    "id": SERVER_ID,
    "name": "[BnB2] beers an bipods",
    "host": "198.51.100.20",
    "port": 2002,
    "directJoinCode": "0053596570",
    "online": True,
    "players": 128,
    "maxPlayers": 128,
    "region": "new_york",
    "scenarioName": "Everon - AAS",
    "gameVersion": "1.9.0.37",
    "battlEye": True,
    "passwordProtected": False,
    "modCount": 3,
    "mods": [
        {"id": "64de57c0a1601d14", "name": "Lunacy Audio", "version": "2.2.0"},
        {"id": "650F545AB9B7E3CD", "name": "Lunacy Overdrive", "version": "1.0.1"},
        {"id": "not-a-workshop-id", "name": "Broken", "version": "1"},
    ],
}


def _mock(monkeypatch, handler):
    """Route the module's httpx calls to `handler`; returns the requests it saw."""
    seen = []
    real_client = httpx.AsyncClient

    def wrapped(request):
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(wrapped), **kw))
    return seen


def _search(**kwargs):
    defaults = dict(q="", page=1, per_page=10, sort="players", region="", include_offline=False, modded_only=False)
    return asyncio.run(servers_route.server_list_search(**{**defaults, **kwargs}, current_user=USER))


def test_search_passes_filters_and_shapes_rows(monkeypatch):
    row = {k: DETAIL[k] for k in ("id", "name", "online", "players", "maxPlayers", "region", "scenarioName", "modCount")}
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json={
        "meta": {"totalPages": 3, "totalServers": 25}, "dataset": {"snapshotAgeSeconds": 12.5}, "data": [row]}))

    out = _search(q="  bipods ", page=2, sort="name", region="new_york", include_offline=True, modded_only=True)

    params = dict(seen[0].url.params)
    assert seen[0].url.path == "/v2/servers"
    assert params == {"page": "2", "perPage": "10", "sort": "name", "search": "bipods", "region": "new_york",
                      "includeOffline": "true", "hasMods": "true"}
    assert seen[0].headers["user-agent"] == "reforger-server-compare/1.0"
    assert out["total"] == 25 and out["total_pages"] == 3 and out["has_next"] and out["has_prev"]
    assert out["list_age_seconds"] == 12.5
    assert out["servers"] == [{
        "id": SERVER_ID, "name": "[BnB2] beers an bipods", "players": 128, "max_players": 128, "status": "online",
        "region": "new_york", "scenario": "Everon - AAS", "version": "", "password": False, "official": False,
        "battleye": False, "mod_count": 3, "page_url": f"https://reforgermods.net/servers/{SERVER_ID}",
    }]


def test_search_drops_unknown_sort_and_region(monkeypatch):
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json={"meta": {}, "data": []}))
    out = _search(sort="-rank", region="mars")
    assert dict(seen[0].url.params) == {"page": "1", "perPage": "10", "sort": "players"}
    assert out["servers"] == [] and not out["has_next"] and not out["has_prev"]


def test_a_pasted_server_link_opens_that_server(monkeypatch):
    seen = _mock(monkeypatch, lambda r: httpx.Response(200, json={"server": DETAIL}))
    out = _search(q=f"https://reforgermods.net/servers/{SERVER_ID.upper()}/")
    assert seen[0].url.path == f"/v2/servers/{SERVER_ID}"
    assert [s["id"] for s in out["servers"]] == [SERVER_ID] and out["total"] == 1


def test_detail_keeps_workshop_mods_only_with_address(monkeypatch):
    _mock(monkeypatch, lambda r: httpx.Response(200, json={"server": DETAIL}))
    out = asyncio.run(servers_route.server_list_detail(SERVER_ID, current_user=USER))
    assert out["mods"] == [
        {"mod_id": "64DE57C0A1601D14", "name": "Lunacy Audio", "version": "2.2.0"},
        {"mod_id": "650F545AB9B7E3CD", "name": "Lunacy Overdrive", "version": "1.0.1"},
    ]
    assert out["mod_count"] == 2
    assert (out["host"], out["port"], out["direct_join_code"]) == ("198.51.100.20", 2002, "0053596570")
    assert out["battleye"] is True and out["status"] == "online"


def test_detail_rejects_an_id_that_is_not_a_server_list_id():
    with pytest.raises(HTTPException) as err:
        asyncio.run(servers_route.server_list_detail("../admin", current_user=USER))
    assert err.value.status_code == 400


@pytest.mark.parametrize("status, body, want_status, want_text", [
    (404, {"error": {"code": "SERVER_NOT_FOUND", "message": "gone"}}, 404, "not in the public server list"),
    (429, {"error": {"code": "RATE_LIMITED"}}, 429, "60 lookups a minute"),
    (500, {"error": {"message": "upstream down"}}, 502, "(500): upstream down"),
    (202, {}, 503, "refreshing"),
])
def test_refusals_read_as_plain_words(monkeypatch, status, body, want_status, want_text):
    _mock(monkeypatch, lambda r: httpx.Response(status, json=body))
    with pytest.raises(HTTPException) as err:
        asyncio.run(servers_route.server_list_detail(SERVER_ID, current_user=USER))
    assert err.value.status_code == want_status
    assert want_text in err.value.detail


def test_unreachable_list_is_a_502(monkeypatch):
    def boom(request):
        raise httpx.ConnectError("no route", request=request)

    _mock(monkeypatch, boom)
    with pytest.raises(HTTPException) as err:
        _search(q="x")
    assert err.value.status_code == 502 and "Could not reach" in err.value.detail
