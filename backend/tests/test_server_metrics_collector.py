import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("MONGO_URL", "mongodb://localhost:27017")
os.environ.setdefault("DB_NAME", "test_db")

import services.server_metrics_collector as collector

STATS_LINE = (
    "19:31:01.869   DEFAULT      : FPS: 88.5, frame time (avg: 11.1 ms, min: 10.1 ms, max: 12.0 ms), "
    "Mem: 598351 kB, Player: 3, AI: 7, AIChar: 0, Veh: 2 (7)"
)
SERVER = {
    "id": "srv-metrics",
    "name": "Metrics",
    "status": "running",
    "log_stats_enabled": True,
    "ports": {"query": 17777, "rcon": 19999},
    "config": {"rcon": {"password": "pw"}, "game": {"maxPlayers": 64}},
}


def _fake_logs(monkeypatch, texts):
    async def fake_log_text(server, tail=400):
        return texts.pop(0)

    monkeypatch.setattr(collector, "get_recent_server_log_text", fake_log_text)


def test_logstats_sample_is_reused_between_minute_samples(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(collector.time, "monotonic", lambda: clock[0])
    collector._last_logstats.clear()
    _fake_logs(monkeypatch, [STATS_LINE, "no stats in this tail", "still none"])

    first = asyncio.run(collector._collect_fps_metric(SERVER, "ctr"))
    clock[0] += 45
    second = asyncio.run(collector._collect_fps_metric(SERVER, "ctr"))
    clock[0] += collector.LOGSTATS_SAMPLE_MAX_AGE_SECONDS
    third = asyncio.run(collector._collect_fps_metric(SERVER, "ctr"))

    assert first == {"server_fps": 88.5, "logstats_player_count": 3, "ai_count": 7, "vehicle_count": 2}
    assert second == first
    assert third == {}


def test_metrics_take_player_count_from_a2s_without_rcon(monkeypatch):
    collector._last_logstats.clear()
    inserted = []

    class FakeMetrics:
        async def find_one(self, *args, **kwargs):
            return None

        async def insert_one(self, doc):
            inserted.append(doc)

    class FakeDb:
        server_metrics = FakeMetrics()

    async def fake_stats(name):
        return {
            "cpu_host_percent": 1.0, "cpu_raw_percent": 1.0, "cpu_cores_used": 0.1,
            "cpu_core_count": 8, "memory_mb": 100, "memory_limit_mb": 1000,
            "network_rx": 0, "network_tx": 0,
        }

    async def fake_inspect(name):
        return {}

    async def fake_a2s(host, port):
        return {"player_count": 5, "max_players": 64, "name": "Metrics", "map": "Everon", "version": "1"}

    monkeypatch.setattr(collector, "db", FakeDb())
    monkeypatch.setattr(collector, "notify", lambda *args, **kwargs: None)
    monkeypatch.setattr(collector.docker_agent, "get_container_stats", fake_stats)
    monkeypatch.setattr(collector.docker_agent, "inspect_container", fake_inspect)
    monkeypatch.setattr(collector, "query_a2s_info", fake_a2s)
    _fake_logs(monkeypatch, [STATS_LINE])

    doc = asyncio.run(collector.collect_server_metrics(SERVER))

    assert not hasattr(collector, "bercon_client")
    assert doc["player_count"] == 5
    assert doc["metric_sources"]["player_count"] == "a2s"
    assert doc["server_fps"] == 88.5
    assert inserted == [doc]
