"""Async Docker facade for local Arma Reforger container orchestration."""

from __future__ import annotations

import asyncio
import logging
import threading
from typing import Any, Dict, List, Optional, Tuple

from config import DOCKER_SOCKET_PATH

logger = logging.getLogger(__name__)

# docker commit of a server container (about 20 GB) has taken about 2 minutes.
COMMIT_TIMEOUT_SECONDS = 1200

_docker_client = None


def _get_client():
    global _docker_client
    if _docker_client is not None:
        return _docker_client

    try:
        import docker
    except ImportError:
        logger.warning("docker package is not installed")
        return None

    try:
        _docker_client = docker.DockerClient(base_url=DOCKER_SOCKET_PATH)
        _docker_client.ping()
    except Exception as exc:
        logger.warning("Unable to connect to Docker daemon at %s: %s", DOCKER_SOCKET_PATH, exc)
        _docker_client = None
    return _docker_client


def _cpu_core_count(stats: dict) -> int:
    try:
        cpu = stats["cpu_stats"]
        return len(cpu["cpu_usage"].get("percpu_usage", [])) or int(cpu.get("online_cpus") or 1)
    except (KeyError, TypeError, ValueError):
        return 1


def _calculate_cpu_percent(stats: dict) -> float:
    try:
        cpu = stats["cpu_stats"]
        pre = stats["precpu_stats"]
        delta_container = cpu["cpu_usage"]["total_usage"] - pre["cpu_usage"]["total_usage"]
        delta_system = cpu["system_cpu_usage"] - pre["system_cpu_usage"]
        num_cpus = _cpu_core_count(stats)
        if delta_system > 0:
            return round((delta_container / delta_system) * num_cpus * 100.0, 2)
    except (KeyError, TypeError, ZeroDivisionError):
        return 0.0
    return 0.0


def _normalize_host_cpu_percent(raw_cpu_percent: float, cpu_core_count: int) -> float:
    if cpu_core_count <= 0:
        return round(raw_cpu_percent, 2)
    return round(max(0.0, raw_cpu_percent / cpu_core_count), 2)


class DockerAgent:
    async def ping(self) -> Tuple[bool, Optional[str]]:
        client = _get_client()
        if client is None:
            return False, "Docker client is not available"
        try:
            await asyncio.to_thread(client.ping)
            return True, None
        except Exception as exc:
            logger.error("Failed to ping Docker daemon: %s", exc)
            return False, str(exc)

    async def ensure_image(self, image: str) -> Tuple[bool, Optional[str]]:
        client = _get_client()
        if client is None:
            return False, "Docker client is not available"
        try:
            await asyncio.to_thread(client.images.get, image)
            return True, None
        except Exception:
            try:
                await asyncio.to_thread(client.images.pull, image)
                return True, None
            except Exception as exc:
                logger.error("Failed to pull image %s: %s", image, exc)
                return False, str(exc)

    async def pull_image(self, image: str) -> Tuple[bool, Optional[str]]:
        """Pull the configured image even when its tag already exists locally."""
        client = _get_client()
        if client is None:
            return False, "Docker client is not available"
        try:
            await asyncio.to_thread(client.images.pull, image)
            return True, None
        except Exception as exc:
            logger.error("Failed to update image %s: %s", image, exc)
            return False, str(exc)

    async def _missing_container_reason(self) -> str:
        """Explain why ``get_container`` returned nothing.

        ``get_container`` collapses "no such container" and "Docker is not
        reachable" into ``None``. Reporting the second as "Container does not
        exist" sent operators looking for a deleted container during a daemon
        outage, so the failure path checks which one it was.
        """
        client = _get_client()
        if client is None:
            return "Docker client is not available"
        try:
            await asyncio.to_thread(client.ping)
        except Exception as exc:
            return f"Docker daemon is not reachable: {exc}"
        return "Container does not exist"

    async def get_container(self, container_name: str):
        client = _get_client()
        if client is None:
            return None
        try:
            return await asyncio.to_thread(client.containers.get, container_name)
        except Exception:
            return None

    async def create_container(
        self,
        *,
        image: str,
        container_name: str,
        ports: Dict[str, int],
        environment: Dict[str, str],
        volumes: Dict[str, Dict[str, str]],
        user: Optional[str] = None,
        cap_add: Optional[list] = None,
        group_add: Optional[list] = None,
        security_opt: Optional[list] = None,
        main_stack_unlimited: bool = False,
        command: Optional[List[str]] = None,
    ) -> Tuple[bool, str]:
        client = _get_client()
        if client is None:
            return False, "Docker client is not available"

        ok, error = await self.ensure_image(image)
        if not ok:
            return False, error or "Failed to pull image"

        existing = await self.get_container(container_name)
        if existing is not None:
            return True, getattr(existing, "id", "")

        # Only pass permission knobs through when explicitly configured so the
        # image's own defaults (and existing deployments) are preserved when the
        # operator hasn't set anything.
        extra_kwargs: Dict[str, Any] = {}
        if user:
            extra_kwargs["user"] = user
        if cap_add:
            extra_kwargs["cap_add"] = list(cap_add)
        if group_add:
            extra_kwargs["group_add"] = list(group_add)
        if security_opt:
            extra_kwargs["security_opt"] = list(security_opt)
        if command:
            extra_kwargs["command"] = list(command)
        if main_stack_unlimited:
            # Unlimited RLIMIT_STACK so Reforger's deep main-thread recursion
            # (prefab/EntityCatalog resolution with large mod sets) doesn't
            # overflow the default 8 MB main stack and SIGSEGV on world load.
            # -1/-1 == RLIM_INFINITY. See REFORGER_MAIN_STACK_UNLIMITED.
            from docker.types import Ulimit

            extra_kwargs["ulimits"] = [Ulimit(name="stack", soft=-1, hard=-1)]

        # Cap container log growth. Arma Reforger servers are extremely chatty
        # and Docker's default json-file driver has no rotation, so a long-lived
        # container's log grows unbounded until it fills the disk and the server
        # starts failing. 3 x 50 MiB per server is ample for the live console and
        # log-monitor windows while bounding worst-case disk usage.
        from docker.types import LogConfig

        log_config = LogConfig(
            type=LogConfig.types.JSON,
            config={"max-size": "50m", "max-file": "3"},
        )

        try:
            container = await asyncio.to_thread(
                lambda: client.containers.create(
                    image=image,
                    name=container_name,
                    detach=True,
                    # Game and query (A2S) ports must be public for players
                    # and the server browser. RCON is admin-level and only the
                    # backend's rcon_bridge uses it, from this same host
                    # (server_runtime_host -> 127.0.0.1), so it is published on
                    # loopback only. Docker-published ports bypass UFW, so a
                    # 0.0.0.0 binding here exposed admin RCON to the internet.
                    ports={
                        f"{ports['game']}/udp": ports["game"],
                        f"{ports['query']}/udp": ports["query"],
                        f"{ports['rcon']}/udp": ("127.0.0.1", ports["rcon"]),
                    },
                    environment=environment,
                    volumes=volumes,
                    restart_policy={"Name": "unless-stopped"},
                    tty=False,
                    stdin_open=False,
                    log_config=log_config,
                    **extra_kwargs,
                )
            )
            logger.info("Created container %s (%s)", container_name, container.id)
            return True, container.id
        except Exception as exc:
            logger.error("Failed to create container %s: %s", container_name, exc)
            return False, str(exc)

    async def start_existing_container(self, container_name: str) -> Tuple[bool, Optional[str]]:
        container = await self.get_container(container_name)
        if container is None:
            return False, await self._missing_container_reason()
        try:
            await asyncio.to_thread(container.start)
            await asyncio.to_thread(container.reload)
            return True, None
        except Exception as exc:
            logger.error("Failed to start container %s: %s", container_name, exc)
            return False, str(exc)

    async def stop_container(self, container_name: str, timeout: int = 30) -> Tuple[bool, Optional[str]]:
        container = await self.get_container(container_name)
        if container is None:
            return False, await self._missing_container_reason()
        try:
            await asyncio.to_thread(container.stop, timeout=timeout)
            return True, None
        except Exception as exc:
            logger.error("Failed to stop container %s: %s", container_name, exc)
            return False, str(exc)

    async def restart_container(self, container_name: str, timeout: int = 30) -> Tuple[bool, Optional[str]]:
        container = await self.get_container(container_name)
        if container is None:
            return False, await self._missing_container_reason()
        try:
            await asyncio.to_thread(container.restart, timeout=timeout)
            return True, None
        except Exception as exc:
            logger.error("Failed to restart container %s: %s", container_name, exc)
            return False, str(exc)

    async def remove_container(self, container_name: str, force: bool = False) -> Tuple[bool, Optional[str]]:
        container = await self.get_container(container_name)
        if container is None:
            return True, None
        try:
            # v=True also removes the container's ANONYMOUS volumes. The image
            # keeps the downloaded game (12+ GB) in one at /steamcmd; once the
            # container is gone nothing can reuse it, so leaving it leaked disk
            # on every delete and every container replacement. Bind mounts and
            # named volumes are never touched by this flag.
            await asyncio.to_thread(container.remove, force=force, v=True)
            return True, None
        except Exception as exc:
            logger.error("Failed to remove container %s: %s", container_name, exc)
            return False, str(exc)

    async def published_host_ports(self) -> set:
        """Every host port any container on this machine binds, running or not.

        The panel's database only knows its own servers. Another panel or tool
        on the same host can hold a port the database
        thinks is free, and Docker then refuses to start the new container.
        """
        client = _get_client()
        if client is None:
            return set()

        def _collect() -> set:
            used: set = set()
            for container in client.containers.list(all=True):
                bindings = (container.attrs.get("HostConfig") or {}).get("PortBindings") or {}
                for host_list in bindings.values():
                    for binding in host_list or []:
                        port = str((binding or {}).get("HostPort") or "")
                        if port.isdigit():
                            used.add(int(port))
            return used

        try:
            return await asyncio.to_thread(_collect)
        except Exception as exc:
            logger.warning("Could not read Docker port bindings: %s", exc)
            return set()

    async def inspect_container(self, container_name: str) -> Optional[Dict[str, Any]]:
        container = await self.get_container(container_name)
        if container is None:
            return None
        try:
            await asyncio.to_thread(container.reload)
            attrs = container.attrs
            state = attrs.get("State", {})
            config = attrs.get("Config", {})
            network = attrs.get("NetworkSettings", {})
            ports = network.get("Ports", {})
            mounts = attrs.get("Mounts", [])
            return {
                "id": container.id,
                "name": attrs.get("Name", "").lstrip("/"),
                "image": config.get("Image", ""),
                "command": config.get("Cmd") or [],
                "status": state.get("Status", "unknown"),
                "running": state.get("Running", False),
                "started_at": state.get("StartedAt"),
                "finished_at": state.get("FinishedAt"),
                "exit_code": state.get("ExitCode"),
                "restart_count": attrs.get("RestartCount", 0),
                "mounts": mounts,
                "ports": ports,
            }
        except Exception as exc:
            logger.error("Failed to inspect container %s: %s", container_name, exc)
            return None

    async def get_container_environment(self, container_name: str) -> Optional[Dict[str, str]]:
        container = await self.get_container(container_name)
        if container is None:
            return None
        try:
            await asyncio.to_thread(container.reload)
            raw_env = container.attrs.get("Config", {}).get("Env", [])
            if not isinstance(raw_env, list):
                return {}

            environment: Dict[str, str] = {}
            for entry in raw_env:
                if not isinstance(entry, str):
                    continue
                key, separator, value = entry.partition("=")
                if not separator or not key:
                    continue
                environment[key] = value
            return environment
        except Exception as exc:
            logger.error("Failed to inspect environment for container %s: %s", container_name, exc)
            return None

    async def get_container_status(self, container_name: str) -> Optional[Dict[str, Any]]:
        details = await self.inspect_container(container_name)
        if details is None:
            return None
        return {
            "status": details["status"],
            "running": details["running"],
            "started_at": details["started_at"],
            "restart_count": details.get("restart_count", 0),
        }

    async def get_container_logs(
        self,
        container_name: str,
        tail: int = 200,
        since: Optional[int] = None,
    ) -> str:
        container = await self.get_container(container_name)
        if container is None:
            return ""
        try:
            kwargs: Dict[str, Any] = {"tail": tail, "timestamps": True}
            if since is not None:
                kwargs["since"] = since
            log_bytes = await asyncio.to_thread(container.logs, **kwargs)
            if isinstance(log_bytes, bytes):
                return log_bytes.decode("utf-8", errors="replace")
            return str(log_bytes)
        except Exception as exc:
            logger.error("Failed to fetch logs for %s: %s", container_name, exc)
            return ""

    async def stream_container_logs(
        self,
        container_name: str,
        *,
        tail: int = 0,
        since: Optional[int] = None,
    ):
        container = await self.get_container(container_name)
        if container is None:
            return

        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Optional[str]] = asyncio.Queue(maxsize=512)
        stop_event = threading.Event()

        def _pump_logs() -> None:
            stream = None
            try:
                kwargs: Dict[str, Any] = {
                    "stream": True,
                    "follow": True,
                    "timestamps": True,
                    "tail": tail,
                }
                if since is not None:
                    kwargs["since"] = since
                stream = container.logs(**kwargs)
                for chunk in stream:
                    if stop_event.is_set():
                        break
                    text = chunk.decode("utf-8", errors="replace") if isinstance(chunk, bytes) else str(chunk)
                    future = asyncio.run_coroutine_threadsafe(queue.put(text), loop)
                    try:
                        future.result(timeout=10.0)
                    except TimeoutError:
                        logger.warning("Log stream queue put timed out for %s, stopping producer", container_name)
                        break
                    except Exception as put_exc:
                        logger.warning("Log stream queue put failed for %s, stopping producer: %s", container_name, put_exc)
                        break
            except Exception as exc:
                logger.error("Failed to stream logs for %s: %s", container_name, exc)
            finally:
                if hasattr(stream, "close"):
                    try:
                        stream.close()
                    except Exception:
                        pass
                asyncio.run_coroutine_threadsafe(queue.put(None), loop)

        worker = threading.Thread(target=_pump_logs, name=f"log-stream-{container_name}", daemon=True)
        worker.start()

        try:
            while True:
                chunk = await queue.get()
                if chunk is None:
                    break
                yield chunk
        finally:
            stop_event.set()

    async def get_container_ip(self, container_name: str) -> Optional[str]:
        container = await self.get_container(container_name)
        if container is None:
            return None
        try:
            await asyncio.to_thread(container.reload)
            networks = container.attrs.get("NetworkSettings", {}).get("Networks", {})
            for net_info in networks.values():
                ip = net_info.get("IPAddress")
                if ip:
                    return ip
        except Exception as exc:
            logger.debug("Could not resolve IP for %s: %s", container_name, exc)
        return None

    async def get_container_stats(self, container_name: str) -> Optional[Dict[str, Any]]:
        container = await self.get_container(container_name)
        if container is None:
            return None
        try:
            stats = await asyncio.to_thread(container.stats, stream=False)
            mem = stats.get("memory_stats", {})
            networks = stats.get("networks", {})
            cpu_raw_percent = _calculate_cpu_percent(stats)
            cpu_core_count = _cpu_core_count(stats)
            return {
                "cpu_percent": cpu_raw_percent,
                "cpu_raw_percent": cpu_raw_percent,
                "cpu_host_percent": _normalize_host_cpu_percent(cpu_raw_percent, cpu_core_count),
                "cpu_core_count": cpu_core_count,
                "cpu_cores_used": round(cpu_raw_percent / 100.0, 2),
                "memory_mb": round(mem.get("usage", 0) / (1024 * 1024), 2),
                "memory_limit_mb": round(mem.get("limit", 0) / (1024 * 1024), 2),
                "network_rx": sum(iface.get("rx_bytes", 0) for iface in networks.values()),
                "network_tx": sum(iface.get("tx_bytes", 0) for iface in networks.values()),
            }
        except Exception as exc:
            logger.error("Failed to fetch stats for %s: %s", container_name, exc)
            return None

    # -- one-off containers (the pre-launch script check) ---------------------

    async def read_container_file(self, container_name: str, path: str, max_bytes: int) -> Optional[bytes]:
        """Bytes of one file inside a container (running or stopped), or None."""
        container = await self.get_container(container_name)
        if container is None:
            return None

        def _read() -> Optional[bytes]:
            import io
            import tarfile

            stream, _stat = container.get_archive(path)
            buffer = io.BytesIO()
            for chunk in stream:
                buffer.write(chunk)
                if buffer.tell() > max_bytes + 1024 * 1024:
                    return None
            buffer.seek(0)
            with tarfile.open(fileobj=buffer) as archive:
                member = next((m for m in archive.getmembers() if m.isfile()), None)
                if member is None:
                    return None
                extracted = archive.extractfile(member)
                return extracted.read() if extracted else None

        try:
            return await asyncio.to_thread(_read)
        except Exception as exc:
            logger.info("Could not read %s from %s: %s", path, container_name, exc)
            return None

    async def image_exists(self, image: str) -> bool:
        client = _get_client()
        if client is None:
            return False
        try:
            await asyncio.to_thread(client.images.get, image)
            return True
        except Exception:
            return False

    async def commit_container(self, container_name: str, repository: str, tag: str) -> Tuple[bool, Optional[str]]:
        """Snapshot a container's own filesystem (not its mounts) as an image.

        ``pause=False``: the source may be a live game server and must not freeze.
        """
        def _commit() -> None:
            import docker

            # Copying a game install takes minutes; the shared client gives up after 60 s.
            client = docker.DockerClient(base_url=DOCKER_SOCKET_PATH, timeout=COMMIT_TIMEOUT_SECONDS)
            try:
                client.containers.get(container_name).commit(repository=repository, tag=tag, pause=False)
            finally:
                client.close()

        if await self.get_container(container_name) is None:
            return False, "Container not found"
        try:
            await asyncio.to_thread(_commit)
            return True, None
        except Exception as exc:
            logger.error("Failed to commit %s as %s:%s: %s", container_name, repository, tag, exc)
            return False, str(exc)

    async def list_image_tags(self, repository: str) -> List[str]:
        client = _get_client()
        if client is None:
            return []
        try:
            images = await asyncio.to_thread(client.images.list, repository)
        except Exception:
            return []
        return [tag for image in images for tag in (image.tags or []) if tag.startswith(repository + ":")]

    async def remove_image(self, image: str) -> None:
        client = _get_client()
        if client is None:
            return
        try:
            await asyncio.to_thread(lambda: client.images.remove(image, force=False))
        except Exception as exc:
            logger.info("Could not remove image %s: %s", image, exc)

    async def run_once(
        self,
        *,
        image: str,
        name: str,
        command: List[str],
        volumes: Dict[str, Dict[str, str]],
        tmpfs: Dict[str, str],
        timeout: int,
        mem_limit: str,
        nano_cpus: int,
    ) -> Tuple[Optional[int], str, Optional[str]]:
        """Run a short-lived container with no network; returns (exit code, output, error)."""
        client = _get_client()
        if client is None:
            return None, "", "Docker is not available"

        def _run() -> Tuple[Optional[int], str, Optional[str]]:
            try:
                stale = client.containers.get(name)
                stale.remove(force=True, v=True)
            except Exception:
                pass
            container = client.containers.run(
                image,
                entrypoint=command[:1],
                command=command[1:],
                name=name,
                detach=True,
                network_mode="none",
                volumes=volumes,
                tmpfs=tmpfs,
                mem_limit=mem_limit,
                nano_cpus=nano_cpus,
                working_dir="/reforger",
                labels={"garrison.role": "prelaunch-check"},
            )
            error = None
            exit_code: Optional[int] = None
            try:
                exit_code = int(container.wait(timeout=timeout).get("StatusCode", -1))
            except Exception as exc:
                error = f"timed out or failed while waiting: {exc}"
            try:
                output = container.logs(stdout=True, stderr=True, tail=400).decode("utf-8", errors="replace")
            except Exception:
                output = ""
            try:
                container.remove(force=True, v=True)
            except Exception as exc:
                logger.warning("Could not remove one-off container %s: %s", name, exc)
            return exit_code, output, error

        try:
            return await asyncio.to_thread(_run)
        except Exception as exc:
            logger.error("One-off container %s failed: %s", name, exc)
            return None, "", str(exc)
