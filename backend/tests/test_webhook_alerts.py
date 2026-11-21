from services.webhook_alerts import alert_payload, detect_down_transitions


def test_first_pass_only_records_state():
    alerts, last = detect_down_transitions([{"id": "a", "name": "A", "status": "error"}], {})
    assert alerts == []
    assert last == {"a": "error"}


def test_alerts_once_when_a_server_goes_down():
    alerts, last = detect_down_transitions([{"id": "a", "name": "A", "status": "crash_loop"}], {"a": "running"})
    assert alerts == [{"id": "a", "name": "A", "status": "crash_loop"}]
    again, _ = detect_down_transitions([{"id": "a", "name": "A", "status": "error"}], last)
    assert again == []  # still down: no repeat


def test_a_clean_stop_is_not_an_alert():
    alerts, _ = detect_down_transitions([{"id": "a", "name": "A", "status": "stopped"}], {"a": "running"})
    assert alerts == []


def test_payload_is_discord_compatible():
    body = alert_payload({"id": "a", "name": "Alpha", "status": "error"})
    assert "Alpha" in body["content"] and body["event"] == "server_down"


def test_deliver_posts_each_alert_to_each_enabled_hook(monkeypatch):
    import asyncio

    import httpx

    import services.webhook_alerts as wa
    from tests.memory_db import MemoryDb

    posted = []

    def handler(request):
        posted.append((str(request.url), request.read()))
        return httpx.Response(204)

    real_client = httpx.AsyncClient
    monkeypatch.setattr(wa.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    monkeypatch.setattr(wa, "db", MemoryDb(server_webhooks=[
        {"id": "1", "name": "on", "url": "https://hooks.example/a", "enabled": True},
        {"id": "2", "name": "off", "url": "https://hooks.example/b", "enabled": False},
    ]))
    sent = asyncio.run(wa.deliver([{"id": "s", "name": "Alpha", "status": "error"}]))
    assert sent == 1
    assert posted[0][0] == "https://hooks.example/a"
    assert b"Alpha" in posted[0][1]
