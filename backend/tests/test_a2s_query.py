import asyncio
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.a2s_query import query_a2s_info

HEADER = b"\xFF\xFF\xFF\xFF"
INFO_REPLY = (
    HEADER + b"\x49\x11" + b"Garrison\x00" + b"Everon\x00" + b"\x00" + b"Arma Reforger\x00"
    + struct.pack("<H", 0) + bytes([3, 64, 0]) + b"dl" + bytes([0, 0]) + b"1.8.0.13\x00"
)


class ChallengeServer(asyncio.DatagramProtocol):
    """Answers the first query with a challenge, as Reforger does, then with the info."""

    def __init__(self, reply=True):
        self.reply = reply
        self.transport = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        if not self.reply:
            return
        if data.endswith(b"\x00"):
            self.transport.sendto(HEADER + b"\x41" + b"\x01\x02\x03\x04", addr)
        elif data.endswith(b"\x01\x02\x03\x04"):
            self.transport.sendto(INFO_REPLY, addr)


async def _query(reply=True, timeout=1.0):
    loop = asyncio.get_running_loop()

    async def unavailable(*args, **kwargs):
        # uvloop (production) does not implement these loop socket helpers.
        raise NotImplementedError

    for name in ("sock_sendto", "sock_recvfrom"):
        try:
            setattr(loop, name, unavailable)
        except (AttributeError, TypeError):
            pass
    transport, _ = await loop.create_datagram_endpoint(
        lambda: ChallengeServer(reply), local_addr=("127.0.0.1", 0)
    )
    try:
        port = transport.get_extra_info("sockname")[1]
        return await query_a2s_info("127.0.0.1", port, timeout_seconds=timeout)
    finally:
        transport.close()


def test_query_works_without_loop_socket_helpers():
    info = asyncio.run(_query())
    assert info["name"] == "Garrison"
    assert info["player_count"] == 3
    assert info["max_players"] == 64
    assert info["version"] == "1.8.0.13"


def test_query_returns_none_when_server_is_silent():
    assert asyncio.run(_query(reply=False, timeout=0.1)) is None
