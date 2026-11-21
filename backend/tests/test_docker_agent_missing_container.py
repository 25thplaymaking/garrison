"""A container lookup that finds nothing must say whether Docker itself is down."""

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from services.docker_agent import DockerAgent


@pytest.mark.parametrize("method", ["stop_container", "restart_container", "start_existing_container"])
def test_docker_unavailable_is_not_reported_as_missing_container(method):
    agent = DockerAgent()
    with patch("services.docker_agent._get_client", return_value=None):
        ok, error = asyncio.run(getattr(agent, method)("reforger-x"))
    assert ok is False
    assert error == "Docker client is not available"


def test_unreachable_daemon_is_reported_as_such():
    client = MagicMock()
    client.containers.get.side_effect = ConnectionError("socket closed")
    client.ping.side_effect = ConnectionError("socket closed")
    agent = DockerAgent()
    with patch("services.docker_agent._get_client", return_value=client):
        ok, error = asyncio.run(agent.stop_container("reforger-x"))
    assert ok is False
    assert error.startswith("Docker daemon is not reachable")


def test_missing_container_on_healthy_daemon_keeps_its_message():
    client = MagicMock()
    client.containers.get.side_effect = LookupError("No such container")
    client.ping.return_value = True
    agent = DockerAgent()
    with patch("services.docker_agent._get_client", return_value=client):
        ok, error = asyncio.run(agent.restart_container("reforger-x"))
    assert ok is False
    assert error == "Container does not exist"
