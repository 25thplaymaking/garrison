"""New servers must not take a host port another container already holds.

A server once got a game port that no server in the panel's database used,
but another container on the same host did, so Docker refused to start it
("port is already allocated").
"""
from unittest.mock import AsyncMock, patch

import pytest

from config import SERVER_PORT_BASE_GAME, SERVER_PORT_BASE_QUERY, SERVER_PORT_BASE_RCON, SERVER_PORT_BLOCK_SIZE
from routes import servers as server_routes
from tests.memory_db import MemoryDb

STEP = SERVER_PORT_BLOCK_SIZE
ON_HOST = {SERVER_PORT_BASE_GAME, SERVER_PORT_BASE_GAME + STEP, SERVER_PORT_BASE_QUERY + STEP}


@pytest.mark.asyncio
async def test_route_allocator_skips_ports_other_containers_hold():
    db = MemoryDb(managed_servers=[{"id": "s1", "ports": {"game": SERVER_PORT_BASE_GAME + 2 * STEP}}])
    with patch.object(server_routes, "db", db), \
            patch.object(server_routes._docker, "published_host_ports", AsyncMock(return_value=ON_HOST)):
        ports = await server_routes._allocate_ports()
    assert ports == {"game": SERVER_PORT_BASE_GAME + 3 * STEP, "query": SERVER_PORT_BASE_QUERY,
                     "rcon": SERVER_PORT_BASE_RCON}


@pytest.mark.asyncio
async def test_no_docker_means_database_only():
    db = MemoryDb(managed_servers=[])
    with patch.object(server_routes, "db", db), \
            patch.object(server_routes._docker, "published_host_ports", AsyncMock(return_value=set())):
        ports = await server_routes._allocate_ports()
    assert ports["game"] == SERVER_PORT_BASE_GAME
