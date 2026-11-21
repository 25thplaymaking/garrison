"""How many Reforger server instances this panel may run.

Every managed server document is an instance until it is deleted (a server
stuck in deletion still holds its ports and container). Set
MAX_SERVER_INSTANCES to match what your host can carry.
"""
from __future__ import annotations

import os

from database import db

MAX_SERVER_INSTANCES = max(1, int(os.environ.get("MAX_SERVER_INSTANCES", 8)))


class ServerCapacityError(ValueError):
    """All instances are in use."""


async def instances_in_use() -> int:
    return await db.managed_servers.count_documents({})


async def ensure_room() -> None:
    in_use = await instances_in_use()
    if in_use >= MAX_SERVER_INSTANCES:
        raise ServerCapacityError(
            f"This panel runs at most {MAX_SERVER_INSTANCES} server instances and {in_use} are in use. "
            "Delete one, or raise MAX_SERVER_INSTANCES."
        )
