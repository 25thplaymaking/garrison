"""BattlEye RCon bridge for Arma Reforger."""

from __future__ import annotations

import asyncio
import binascii
from collections import deque
from dataclasses import dataclass, field
import hashlib
import logging
import re
import struct
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

BATTLEYE_PREFIX = b"BE"
RCON_TIMEOUT_SECONDS = 8
DEFAULT_MAX_RCON_QUEUE_SIZE = 100
RCON_KEEPALIVE_SECONDS = 20
RCON_RETRY_COOLDOWN_SECONDS = 30
MAX_RCON_RESPONSE_BYTES = 1024 * 1024

# Reforger acknowledges a command with an empty body and sends the output afterwards as
# server messages: "Processing Command: <cmd>", then the reply text. The output usually
# lands within half a second; a hitching server can take longer.
RCON_REPLY_START_SECONDS = 3.0
RCON_REPLY_FIRST_OUTPUT_SECONDS = 1.5
RCON_REPLY_SETTLE_SECONDS = 0.3
_PROCESSING_PREFIX = "Processing Command:"

# ── RCON input-validation constants ──────────────────────────────────────────

# Maximum command length (bytes) that we will send over UDP.
MAX_RCON_COMMAND_LENGTH = 512

# Allowed characters: printable ASCII (space through tilde) — no control
# characters, no DEL (0x7F), no high-byte sequences.
_RCON_ALLOWED_RE = re.compile(r'^[\x20-\x7E]+$')


def validate_rcon_command(command: str) -> str:
    """Validate and sanitize an RCON command string.

    Raises ``ValueError`` with a human-readable message if the command is
    invalid.  Returns the stripped command on success.
    """
    command = command.strip()
    if not command:
        raise ValueError("RCON command must not be empty")
    if len(command) > MAX_RCON_COMMAND_LENGTH:
        raise ValueError(
            f"RCON command exceeds maximum length of {MAX_RCON_COMMAND_LENGTH} characters"
        )
    if not _RCON_ALLOWED_RE.match(command):
        raise ValueError(
            "RCON command contains disallowed characters; "
            "only printable ASCII (0x20–0x7E) is permitted"
        )
    return command


def _wrap_payload(payload: bytes) -> bytes:
    # The checksum covers every byte after the CRC field, including 0xFF.
    wire_payload = b"\xFF" + payload
    checksum = struct.pack("<I", binascii.crc32(wire_payload) & 0xFFFFFFFF)
    return BATTLEYE_PREFIX + checksum + wire_payload


def _parse_packet(data: bytes) -> Optional[bytes]:
    if len(data) < 8 or not data.startswith(BATTLEYE_PREFIX) or data[6] != 0xFF:
        return None
    payload = data[7:]
    expected = struct.unpack("<I", data[2:6])[0]
    actual = binascii.crc32(data[6:]) & 0xFFFFFFFF
    if expected != actual:
        return None
    return payload


@dataclass
class _RconSession:
    transport: asyncio.DatagramTransport
    protocol: "BERConClient._DatagramProtocol"
    credential_digest: bytes = field(repr=False)
    authenticated: bool = False
    sequence: int = 0
    last_command: float = 0


class BERConClient:
    def __init__(self, max_queue_size: int = DEFAULT_MAX_RCON_QUEUE_SIZE) -> None:
        self._max_queue_size = max(1, int(max_queue_size))
        # Per-server FIFO queues keyed by (host, port).  Each queue
        # serialises UDP send/recv to avoid packet collisions.
        self._queues: Dict[Tuple[str, int], asyncio.Queue] = {}
        self._workers: Dict[Tuple[str, int], asyncio.Task] = {}
        self._sessions: Dict[Tuple[str, int], _RconSession] = {}
        self._failures: Dict[Tuple[str, int], Tuple[bytes, float]] = {}
        self._closed = False

    # ── per-server command queue ────────────────────────────────────────

    def _get_queue(self, host: str, port: int) -> asyncio.Queue:
        key = (host, port)
        if key not in self._queues:
            self._queues[key] = asyncio.Queue(maxsize=self._max_queue_size)
        return self._queues[key]

    async def _ensure_worker(self, host: str, port: int) -> None:
        key = (host, port)
        task = self._workers.get(key)
        if task is None or task.done():
            self._workers[key] = asyncio.create_task(self._queue_worker(key))

    # How long (seconds) a queue worker waits for the next command before
    # shutting itself down and releasing its resources.
    _WORKER_IDLE_TIMEOUT: float = 300  # 5 minutes

    async def _queue_worker(self, key: Tuple[str, int]) -> None:
        """Process queued commands one at a time for *key* (host, port).

        The worker shuts itself down after ``_WORKER_IDLE_TIMEOUT`` seconds of
        inactivity so we don't leak tasks/queues for deprovisioned servers.
        """
        queue = self._queues[key]
        loop = asyncio.get_running_loop()
        last_request = loop.time()
        future = None
        try:
            while True:
                idle_remaining = self._WORKER_IDLE_TIMEOUT - (loop.time() - last_request)
                if idle_remaining <= 0 and queue.empty():
                    return
                wait_for = max(0.001, idle_remaining)
                session = self._sessions.get(key)
                if session:
                    wait_for = min(wait_for, max(
                        0.001, RCON_KEEPALIVE_SECONDS - (loop.time() - session.last_command)
                    ))
                try:
                    future, password, command = await asyncio.wait_for(queue.get(), wait_for)
                except asyncio.TimeoutError:
                    if loop.time() - last_request >= self._WORKER_IDLE_TIMEOUT:
                        return
                    if session:
                        await self._keepalive(key, session)
                    continue
                last_request = loop.time()
                try:
                    # Cancellation before dispatch must never become a deferred command.
                    if future.done():
                        continue
                    result = await self._execute_impl(
                        key[0], key[1], password, command, request_future=future
                    )
                    if not future.done():
                        future.set_result(result)
                except Exception as exc:
                    if not future.done():
                        future.set_exception(exc)
                finally:
                    queue.task_done()
        finally:
            self._close_session(key)
            self._failures.pop(key, None)
            self._queues.pop(key, None)
            self._workers.pop(key, None)
            if future is not None and not future.done():
                future.set_result((False, "RCON client closed"))
            while not queue.empty():
                pending, _, _ = queue.get_nowait()
                if not pending.done():
                    pending.set_result((False, "RCON client closed"))
                queue.task_done()

    async def execute(self, host: str, port: int, password: str, command: str) -> Tuple[bool, str]:
        """Enqueue *command* and wait for its result (FIFO per server)."""
        if self._closed:
            return False, "RCON client closed"
        if not password:
            return False, "RCON is disabled because no password is configured"

        loop = asyncio.get_running_loop()
        future: asyncio.Future[Tuple[bool, str]] = loop.create_future()

        queue = self._get_queue(host, port)
        try:
            queue.put_nowait((future, password, command))
        except asyncio.QueueFull:
            future.cancel()
            return False, "RCON command queue is full — try again shortly"
        await self._ensure_worker(host, port)

        return await future

    class _DatagramProtocol(asyncio.DatagramProtocol):
        def __init__(self) -> None:
            self._queue: asyncio.Queue[object] = asyncio.Queue(maxsize=256)
            self.transport: Optional[asyncio.DatagramTransport] = None
            # BattlEye resends a server message until it is acknowledged.
            self._recent_messages: deque[int] = deque(maxlen=64)

        def connection_made(self, transport: asyncio.BaseTransport) -> None:
            self.transport = transport

        def datagram_received(self, data: bytes, addr: Tuple[str, int]) -> None:
            payload = _parse_packet(data)
            if not payload:
                return
            if payload[0] == 0x02 and len(payload) >= 2:
                # Acknowledge every copy, but keep only the first: resends would repeat output.
                if self.transport is not None:
                    self.transport.sendto(_wrap_payload(payload[:2]))
                if payload[1] in self._recent_messages:
                    return
                self._recent_messages.append(payload[1])
            if not self._queue.full():
                self._queue.put_nowait(data)

        def discard_pending(self) -> None:
            """Drop packets that arrived between commands, so they are not read as a reply."""
            while not self._queue.empty():
                self._queue.get_nowait()

        def error_received(self, exc: Exception) -> None:
            if not self._queue.full():
                self._queue.put_nowait(exc)

        async def recv_datagram(self) -> bytes:
            item = await self._queue.get()
            if isinstance(item, Exception):
                raise item
            return item

    async def _open_datagram_endpoint(
        self, host: str, port: int
    ) -> Tuple[asyncio.DatagramTransport, "BERConClient._DatagramProtocol"]:
        loop = asyncio.get_running_loop()
        protocol = self._DatagramProtocol()
        transport, _ = await loop.create_datagram_endpoint(
            lambda: protocol,
            remote_addr=(host, port),
        )
        return transport, protocol

    async def _recv_payload(self, protocol: "BERConClient._DatagramProtocol") -> Optional[bytes]:
        data = await asyncio.wait_for(protocol.recv_datagram(), timeout=RCON_TIMEOUT_SECONDS)
        return _parse_packet(data)

    async def _recv_login_response(self, protocol: "BERConClient._DatagramProtocol") -> Optional[bytes]:
        while True:
            payload = await self._recv_payload(protocol)
            # The "Logged In!" notice can arrive on either side of the login answer.
            if payload and payload[0] == 0x02:
                continue
            return payload

    async def _execute_impl(
        self,
        host: str,
        port: int,
        password: str,
        command: str,
        request_future: Optional[asyncio.Future] = None,
    ) -> Tuple[bool, str]:
        """Use one authenticated UDP endpoint per server and backend worker."""
        key = (host, port)
        credential_digest = hashlib.sha256(password.encode()).digest()
        failure = self._failures.get(key)
        if failure and failure[0] == credential_digest and asyncio.get_running_loop().time() < failure[1]:
            return False, "BattlEye RCON unavailable; retry deferred after a failed exchange"
        command_sent = False
        try:
            # One deadline covers login and reply, even if unrelated packets keep arriving.
            async with asyncio.timeout(RCON_TIMEOUT_SECONDS):
                session = self._sessions.get(key)
                if session and session.credential_digest != credential_digest:
                    self._close_session(key)
                    session = None
                if session is None:
                    transport, protocol = await self._open_datagram_endpoint(host, port)
                    session = _RconSession(transport, protocol, credential_digest)
                    self._sessions[key] = session
                if request_future is not None and request_future.done():
                    if not session.authenticated:
                        self._close_session(key)
                    return False, "RCON command request was cancelled before dispatch"
                if not session.authenticated:
                    session.transport.sendto(_wrap_payload(
                        b"\x00" + password.encode("ascii", errors="ignore")
                    ))
                    login_response = await self._recv_login_response(session.protocol)
                    if login_response != b"\x00\x01":
                        self._mark_failed(key, credential_digest)
                        if login_response == b"\x00\x00":
                            return False, "BattlEye authentication failed"
                        return False, "No valid BattlEye login response received"
                    session.authenticated = True
                    self._failures.pop(key, None)
                if request_future is not None and request_future.done():
                    return False, "RCON command request was cancelled before dispatch"
                command_sent = True
                return True, await self._send_command(session, command)
        except asyncio.TimeoutError:
            self._mark_failed(key, credential_digest)
            if command_sent:
                return False, "BattlEye RCON timed out; execution outcome unknown; command was not retried"
            return False, "BattlEye RCON login timed out; command was not sent"
        except (OSError, ValueError) as exc:
            self._mark_failed(key, credential_digest)
            logger.warning("BattlEye RCON exchange failed (%s)", type(exc).__name__)
            return False, "BattlEye RCON exchange failed; command was not retried"

    async def _send_command(self, session: _RconSession, command: str) -> str:
        sequence = session.sequence
        session.sequence = (sequence + 1) % 256
        session.last_command = asyncio.get_running_loop().time()
        session.protocol.discard_pending()
        session.transport.sendto(_wrap_payload(
            b"\x01" + bytes([sequence]) + command.encode("ascii", errors="ignore")
        ))
        fragments: Dict[int, bytes] = {}
        expected_parts: Optional[int] = None
        response_bytes = 0
        early_messages: List[str] = []
        while True:
            payload = await self._recv_payload(session.protocol)
            if payload and len(payload) >= 2 and payload[0] == 0x02:
                early_messages.append(payload[2:].decode("utf-8", errors="replace"))
                continue
            if not payload or len(payload) < 2 or payload[0] != 1 or payload[1] != sequence:
                continue
            body = payload[2:]
            if not body:
                # An empty keepalive has no output; anything else answers through server messages.
                if not command:
                    return ""
                return await self._collect_reply(session.protocol, early_messages)
            if body[0] != 0:
                return body.decode("utf-8", errors="replace")
            if len(body) < 3 or not body[1] or body[2] >= body[1]:
                raise ValueError("Invalid RCON response fragment")
            if expected_parts is not None and expected_parts != body[1]:
                raise ValueError("Inconsistent RCON response fragments")
            expected_parts = body[1]
            index = body[2]
            if index in fragments and fragments[index] != body[3:]:
                raise ValueError("Conflicting RCON response fragment")
            if index not in fragments:
                fragments[index] = body[3:]
                response_bytes += len(body[3:])
            if response_bytes > MAX_RCON_RESPONSE_BYTES:
                raise ValueError("RCON response exceeded size limit")
            if len(fragments) == expected_parts:
                return b"".join(fragments[i] for i in range(expected_parts)).decode("utf-8", errors="replace")

    async def _collect_reply(
        self, protocol: "BERConClient._DatagramProtocol", early_messages: List[str]
    ) -> str:
        """Gather the server messages that carry a Reforger command's output.

        Replies go only to the client that sent the command, and commands are serialised
        per session, so the next "Processing Command" on this session belongs to this
        command. The echoed text is not compared: any difference in it would turn every
        reply back into an empty one.
        """
        loop = asyncio.get_running_loop()
        pending = list(early_messages)
        lines: List[str] = []
        started = False
        deadline = loop.time() + RCON_REPLY_START_SECONDS
        while True:
            if pending:
                text = pending.pop(0)
            else:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    return "\n".join(lines)
                try:
                    data = await asyncio.wait_for(protocol.recv_datagram(), timeout=remaining)
                except asyncio.TimeoutError:
                    return "\n".join(lines)
                payload = _parse_packet(data)
                if not payload or len(payload) < 2 or payload[0] != 0x02:
                    continue
                text = payload[2:].decode("utf-8", errors="replace")
            if text.startswith(_PROCESSING_PREFIX):
                started = True
                deadline = loop.time() + RCON_REPLY_FIRST_OUTPUT_SECONDS
                continue
            if not started:
                # A notice that was already queued when the command was processed.
                continue
            lines.append(text)
            deadline = loop.time() + RCON_REPLY_SETTLE_SECONDS

    def _close_session(self, key: Tuple[str, int]) -> None:
        session = self._sessions.pop(key, None)
        if session:
            if session.authenticated and not session.transport.is_closing():
                # Reforger's session-only logout frees its slot without changing game state.
                # This is best effort: lost UDP or process termination still relies on expiry.
                try:
                    session.transport.sendto(_wrap_payload(
                        b"\x01" + bytes([session.sequence]) + b"@logout"
                    ))
                except (OSError, RuntimeError):
                    pass
            session.transport.close()

    def _mark_failed(self, key: Tuple[str, int], credential_digest: bytes) -> None:
        self._close_session(key)
        self._failures[key] = (
            credential_digest, asyncio.get_running_loop().time() + RCON_RETRY_COOLDOWN_SECONDS
        )

    async def _keepalive(self, key: Tuple[str, int], session: _RconSession) -> None:
        try:
            async with asyncio.timeout(RCON_TIMEOUT_SECONDS):
                await self._send_command(session, "")
        except (asyncio.TimeoutError, OSError, ValueError):
            self._mark_failed(key, session.credential_digest)

    async def aclose(self) -> None:
        """Finish waiters and release sockets when the application shuts down."""
        self._closed = True
        workers = list(self._workers.values())
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)
        # A task cancelled before its first instruction cannot run its own finally block.
        for queue in self._queues.values():
            while not queue.empty():
                pending, _, _ = queue.get_nowait()
                if not pending.done():
                    pending.set_result((False, "RCON client closed"))
                queue.task_done()
        self._queues.clear()
        self._workers.clear()
        self._failures.clear()
        for key in list(self._sessions):
            self._close_session(key)

    async def probe(self, host: str, port: int, password: str) -> Dict[str, str]:
        if not password:
            return {"state": "disabled", "detail": "RCON password is not configured"}

        # An empty command is the protocol keepalive: it proves the login without running,
        # or logging, a game command.
        ok, response = await self.execute(host, port, password, "")
        if ok:
            return {"state": "connected", "detail": "BattlEye RCON is reachable"}
        if "authentication failed" in response.lower():
            return {"state": "auth_failed", "detail": response}
        if "timed out" in response.lower() or "retry deferred" in response.lower():
            return {"state": "unavailable", "detail": response}
        return {"state": "error", "detail": response}


bercon_client = BERConClient()
