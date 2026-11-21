"""UDP regressions for authenticated RCON slot ownership and command delivery."""

import asyncio
from contextlib import asynccontextmanager
import struct
import zlib

import pytest

import services.rcon_bridge as bridge


def server_packet(payload):
    data = b"\xff" + payload
    return b"BE" + struct.pack("<I", zlib.crc32(data)) + data


def test_protocol_wire_vectors_include_ff_in_checksum():
    # Fixed protocol vectors keep the fake server from masking a shared codec bug.
    assert bridge._parse_packet(bytes.fromhex("424569ddde36ff0001")) == b"\0\1"
    assert bridge._wrap_payload(b"\1\0#players").hex() == "424515b0a552ff010023706c6179657273"
    assert bridge._parse_packet(bytes.fromhex("424569ddde36ff0000")) is None


class SlotLimitedServer(asyncio.DatagramProtocol):
    def __init__(self, slots=16):
        self.slots = slots
        self.transport = None
        self.authenticated = set()
        self.logins = 0
        self.rejections = 0
        self.commands = []
        self.password = b"test-password"
        self.reply = True
        self.acks = asyncio.Queue()
        self.logged_out = asyncio.Event()
        self.login_received = asyncio.Event()
        self.delay_login = False
        self.fragment_mode = None
        # Reforger answers a command with an empty ack, then sends the output as
        # server messages: "Processing Command: <cmd>" followed by the reply text.
        self.reforger_outputs = None
        self.resend_output = False
        self.message_before_login_ack = False
        self.message_sequence = 0

    def connection_made(self, transport):
        self.transport = transport

    def send_message(self, text, addr, sequence=None):
        if sequence is None:
            sequence = self.message_sequence
            self.message_sequence = (self.message_sequence + 1) % 256
        self.transport.sendto(server_packet(b"\2" + bytes([sequence]) + text.encode()), addr)
        return sequence

    def send_reforger_reply(self, command, addr):
        self.send_message(f"Processing Command: {command.decode()}", addr)
        for text in self.reforger_outputs.get(command, []):
            sequence = self.send_message(text, addr)
            if self.resend_output:
                self.send_message(text, addr, sequence)

    def datagram_received(self, data, addr):
        if len(data) < 8 or data[:2] != b"BE" or data[6] != 255:
            return
        if struct.unpack("<I", data[2:6])[0] != zlib.crc32(data[6:]):
            return
        payload = data[7:]
        if payload[0] == 0:
            self.logins += 1
            if addr not in self.authenticated and len(self.authenticated) >= self.slots:
                self.rejections += 1
                return
            ok = payload[1:] == self.password
            if ok:
                self.authenticated.add(addr)
            self.login_received.set()
            if ok and self.message_before_login_ack:
                self.send_message("Logged In! Client ID: #0", addr)
            if not self.delay_login:
                self.transport.sendto(server_packet(b"\0" + bytes([ok])), addr)
        elif payload[0] == 1 and len(payload) >= 2 and addr in self.authenticated:
            self.commands.append((addr, payload[1], payload[2:]))
            if payload[2:] == b"@logout":
                self.authenticated.discard(addr)
                self.logged_out.set()
            if self.reply and self.reforger_outputs is not None:
                self.transport.sendto(server_packet(payload[:2]), addr)
                if payload[2:] and payload[2:] != b"@logout":
                    asyncio.get_running_loop().call_later(
                        0.01, self.send_reforger_reply, payload[2:], addr
                    )
            elif self.reply:
                if self.fragment_mode == "out-of-order":
                    for fragment in (b"\0\2\1K", b"\0\2\1K", b"\0\2\0O"):
                        self.transport.sendto(server_packet(payload[:2] + fragment), addr)
                elif self.fragment_mode == "invalid":
                    self.transport.sendto(server_packet(payload[:2] + b"\0\2\2X"), addr)
                else:
                    self.transport.sendto(server_packet(payload[:2] + b"OK"), addr)
        elif payload[0] == 2:
            self.acks.put_nowait((addr, payload[1]))


async def start_server(slots=16):
    loop = asyncio.get_running_loop()
    server = SlotLimitedServer(slots)
    transport, _ = await loop.create_datagram_endpoint(
        lambda: server, local_addr=("127.0.0.1", 0)
    )
    return server, transport, transport.get_extra_info("sockname")


@asynccontextmanager
async def connected_case(slots=16):
    server, transport, (host, port) = await start_server(slots)
    client = bridge.BERConClient()
    try:
        yield client, server, host, port
    finally:
        await client.aclose()
        transport.close()


def test_more_commands_than_server_slots_reuse_one_authenticated_endpoint(monkeypatch):
    monkeypatch.setattr(bridge, "RCON_TIMEOUT_SECONDS", 0.05)

    async def scenario():
        async with connected_case() as (client, server, host, port):
            results = await asyncio.gather(*(
                client.execute(host, port, "test-password", "#players") for _ in range(40)
            ))
            assert results == [(True, "OK")] * 40
            assert server.logins == 1
            assert server.rejections == 0
            assert len({addr for addr, _, _ in server.commands}) == 1

    asyncio.run(scenario())


def test_backend_workers_use_two_slots_for_hundreds_of_commands():
    async def scenario():
        async with connected_case(slots=2) as (first, server, host, port):
            second = bridge.BERConClient()
            try:
                for _ in range(260):
                    assert await asyncio.gather(
                        first.execute(host, port, "test-password", "#players"),
                        second.execute(host, port, "test-password", "#status"),
                    ) == [(True, "OK"), (True, "OK")]
                assert server.logins == 2
                assert server.rejections == 0
                addresses = {addr for addr, _, _ in server.commands}
                assert len(addresses) == 2
                for addr in addresses:
                    sequences = [seq for peer, seq, _ in server.commands if peer == addr]
                    assert sequences == [i % 256 for i in range(260)]
            finally:
                await second.aclose()

    asyncio.run(scenario())


def test_server_messages_are_acknowledged_while_no_command_is_waiting():
    async def scenario():
        async with connected_case() as (client, server, host, port):
            assert await client.execute(host, port, "test-password", "#players") == (True, "OK")
            addr = server.commands[-1][0]
            server.transport.sendto(bridge._wrap_payload(b"\2\x77idle log"), addr)
            assert await asyncio.wait_for(server.acks.get(), 0.5) == (addr, 0x77)
            assert await client.execute(host, port, "test-password", "#status") == (True, "OK")
            assert server.logins == 1

    asyncio.run(scenario())


def test_idle_keepalive_reuses_session_and_idle_expiry_closes_it(monkeypatch):
    monkeypatch.setattr(bridge, "RCON_KEEPALIVE_SECONDS", 0.02)

    async def scenario():
        async with connected_case() as (client, server, host, port):
            client._WORKER_IDLE_TIMEOUT = 0.15
            assert await client.execute(host, port, "test-password", "#players") == (True, "OK")
            session = client._sessions[(host, port)]
            await asyncio.wait_for(client._workers[(host, port)], 1)
            assert any(command == b"" for _, _, command in server.commands)
            assert server.logins == 1
            assert session.transport.is_closing()
            assert not client._sessions and not client._workers

    asyncio.run(scenario())


def test_timeout_does_not_replay_mutation_or_create_a_reconnect_storm(monkeypatch):
    monkeypatch.setattr(bridge, "RCON_TIMEOUT_SECONDS", 0.05)

    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.reply = False
            ok, message = await client.execute(host, port, "test-password", "#restart")
            assert not ok and "outcome unknown" in message
            for _ in range(30):
                ok, message = await client.execute(host, port, "test-password", "#status")
                assert not ok and "retry deferred" in message
            assert server.logins == 1
            assert [cmd for _, _, cmd in server.commands] == [b"#restart", b"@logout"]
            assert not client._sessions

    asyncio.run(scenario())


def test_next_request_reauthenticates_after_server_loses_session(monkeypatch):
    monkeypatch.setattr(bridge, "RCON_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(bridge, "RCON_RETRY_COOLDOWN_SECONDS", 0)

    async def scenario():
        async with connected_case() as (client, server, host, port):
            assert await client.execute(host, port, "test-password", "#status") == (True, "OK")
            server.authenticated.clear()
            assert (await client.execute(host, port, "test-password", "#restart"))[0] is False
            assert await client.execute(host, port, "test-password", "#players") == (True, "OK")
            assert server.logins == 2
            assert [cmd for _, _, cmd in server.commands] == [b"#status", b"#players"]

    asyncio.run(scenario())


def test_rotated_or_wrong_password_cannot_reuse_previous_authentication():
    async def scenario():
        async with connected_case() as (client, server, host, port):
            assert await client.execute(host, port, "test-password", "#status") == (True, "OK")
            old_session = client._sessions[(host, port)]
            assert await client.execute(host, port, "wrong", "#restart") == (False, "BattlEye authentication failed")
            assert old_session.transport.is_closing()
            assert [cmd for _, _, cmd in server.commands] == [b"#status", b"@logout"]
            server.password = b"rotated"
            assert await client.execute(host, port, "rotated", "#players") == (True, "OK")
            assert server.logins == 3

    asyncio.run(scenario())


def test_cancel_during_login_does_not_send_command():
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.delay_login = True
            request = asyncio.create_task(client.execute(host, port, "test-password", "#restart"))
            await asyncio.wait_for(server.login_received.wait(), 0.5)
            request.cancel()
            with pytest.raises(asyncio.CancelledError):
                await request
            addr = next(iter(server.authenticated))
            server.transport.sendto(bridge._wrap_payload(b"\0\1"), addr)
            await asyncio.wait_for(client._queues[(host, port)].join(), 0.5)
            assert not server.commands

    asyncio.run(scenario())


def test_shutdown_finishes_active_and_queued_requests():
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.delay_login = True
            first = asyncio.create_task(client.execute(host, port, "test-password", "#restart"))
            await asyncio.wait_for(server.login_received.wait(), 0.5)
            second = asyncio.create_task(client.execute(host, port, "test-password", "#shutdown"))
            await asyncio.sleep(0)
            await client.aclose()
            results = await asyncio.wait_for(asyncio.gather(first, second), 0.5)
            assert results == [(False, "RCON client closed")] * 2
            assert not server.commands
            assert not client._sessions and not client._workers and not client._queues
            assert await client.execute(host, port, "test-password", "#restart") == (False, "RCON client closed")

    asyncio.run(scenario())


def test_shutdown_before_worker_starts_finishes_queued_request():
    async def scenario():
        client = bridge.BERConClient()
        request = asyncio.create_task(client.execute("127.0.0.1", 1, "test", "#restart"))
        await asyncio.sleep(0)
        await client.aclose()
        assert await asyncio.wait_for(request, 0.5) == (False, "RCON client closed")
        assert not client._queues

    asyncio.run(scenario())


def test_shutdown_logs_out_authenticated_session_and_frees_server_slot():
    async def scenario():
        async with connected_case(slots=1) as (client, server, host, port):
            assert await client.execute(host, port, "test-password", "#status") == (True, "OK")
            await client.aclose()
            await asyncio.wait_for(server.logged_out.wait(), 0.5)
            assert not server.authenticated
            assert [cmd for _, _, cmd in server.commands] == [b"#status", b"@logout"]

    asyncio.run(scenario())


@pytest.mark.parametrize("mode,success", [("out-of-order", True), ("invalid", False)])
def test_duplicate_out_of_order_and_invalid_fragments(mode, success):
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.fragment_mode = mode
            ok, message = await client.execute(host, port, "test-password", "#players")
            assert ok is success
            if success:
                assert message == "OK"
            else:
                assert not client._sessions

    asyncio.run(scenario())


def test_unrelated_responses_cannot_extend_command_deadline(monkeypatch):
    monkeypatch.setattr(bridge, "RCON_TIMEOUT_SECONDS", 0.05)

    async def scenario():
        async with connected_case() as (client, server, host, port):
            assert await client.execute(host, port, "test-password", "#status") == (True, "OK")
            server.reply = False
            addr = server.commands[-1][0]

            async def chatter():
                while True:
                    server.transport.sendto(bridge._wrap_payload(b"\1\xffunrelated"), addr)
                    await asyncio.sleep(0.005)

            task = asyncio.create_task(chatter())
            try:
                result = await asyncio.wait_for(client.execute(host, port, "test-password", "#players"), 0.5)
                assert result[0] is False and "timed out" in result[1]
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


PLAYERS_HEADER = "Players on server: [Player#] ; [Player UID] ; [Player Name]"


@pytest.fixture
def fast_reforger_replies(monkeypatch):
    monkeypatch.setattr(bridge, "RCON_REPLY_START_SECONDS", 0.5)
    monkeypatch.setattr(bridge, "RCON_REPLY_FIRST_OUTPUT_SECONDS", 0.2)
    monkeypatch.setattr(bridge, "RCON_REPLY_SETTLE_SECONDS", 0.05)


def test_reforger_reply_after_empty_ack_is_returned(fast_reforger_replies):
    async def scenario():
        async with connected_case() as (client, server, host, port):
            row = "1 ; 1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d ; Kestrel"
            server.reforger_outputs = {b"#players": [f"{PLAYERS_HEADER}\n{row}"]}
            assert await client.execute(host, port, "test-password", "#players") == (
                True, f"{PLAYERS_HEADER}\n{row}",
            )

    asyncio.run(scenario())


def test_reforger_resent_messages_are_acked_once_and_not_duplicated(fast_reforger_replies):
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.resend_output = True
            server.reforger_outputs = {b"#ban list": ["Ban page 1", "Ban page 2"]}
            ok, reply = await client.execute(host, port, "test-password", "#ban list")
            assert (ok, reply) == (True, "Ban page 1\nBan page 2")
            acked = []
            while not server.acks.empty():
                acked.append(server.acks.get_nowait()[1])
            # Processing + two outputs, each resent output acknowledged again.
            assert sorted(acked) == [0, 1, 1, 2, 2]

    asyncio.run(scenario())


def test_reforger_command_without_output_returns_empty_reply(fast_reforger_replies):
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.reforger_outputs = {}
            assert await client.execute(host, port, "test-password", "#restart") == (True, "")
            assert server.logins == 1
            assert client._sessions

    asyncio.run(scenario())


def test_reforger_stale_messages_are_not_attributed_to_next_command(fast_reforger_replies):
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.reforger_outputs = {b"#players": [PLAYERS_HEADER]}
            assert await client.execute(host, port, "test-password", "#players") == (True, PLAYERS_HEADER)
            addr = server.commands[-1][0]
            server.send_message("unsolicited broadcast", addr)
            await asyncio.wait_for(server.acks.get(), 0.5)
            await asyncio.sleep(0.05)
            assert await client.execute(host, port, "test-password", "#players") == (True, PLAYERS_HEADER)

    asyncio.run(scenario())


def test_server_message_before_login_ack_does_not_fail_login(fast_reforger_replies):
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.message_before_login_ack = True
            server.reforger_outputs = {b"#players": [PLAYERS_HEADER]}
            assert await client.execute(host, port, "test-password", "#players") == (True, PLAYERS_HEADER)
            assert server.logins == 1

    asyncio.run(scenario())


def test_probe_logs_in_with_keepalive_and_sends_no_game_command(fast_reforger_replies):
    async def scenario():
        async with connected_case() as (client, server, host, port):
            server.reforger_outputs = {}
            assert await client.probe(host, port, "test-password") == {
                "state": "connected", "detail": "BattlEye RCON is reachable",
            }
            assert [cmd for _, _, cmd in server.commands] == [b""]

    asyncio.run(scenario())
