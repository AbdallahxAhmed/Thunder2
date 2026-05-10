"""Engine registry and protocol definition.

Each engine client must implement an ``execute(job, request)`` method that
runs the download synchronously (blocking).  The orchestrator in ``main.py``
wraps each call in ``asyncio.to_thread()``.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from src.models import DownloadJob, DownloadRequest


@runtime_checkable
class EngineProtocol(Protocol):
    """Interface that all engine clients must satisfy."""

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Run a download and return a result dict.

        Must contain at minimum:
          - ``status``: ``"completed"`` or ``"failed"``
          - ``output_path``: path to the downloaded file (on success)
          - ``error``: error message (on failure)
        """
        ...


# Lazy engine map — populated as engine modules are imported.
# Keys are the names returned by ``router.classify()``: "aria2", "ytdlp", "m3u8"
ENGINE_MAP: dict[str, EngineProtocol] = {}


def register_engine(name: str, engine: EngineProtocol) -> None:
    """Register an engine client instance."""
    ENGINE_MAP[name] = engine


def get_engine(name: str) -> EngineProtocol | None:
    """Look up an engine by name."""
    return ENGINE_MAP.get(name)


def _register_defaults() -> None:
    """Import and register all built-in engine clients.

    Called once at application startup from ``main.py`` lifespan.
    """
    from src.engines.aria2_client import Aria2Client

    register_engine("aria2", Aria2Client())

    # yt-dlp — registered if importable
    try:
        from src.engines.ytdlp_client import YtdlpClient

        register_engine("ytdlp", YtdlpClient())
    except ImportError:
        pass

    # N_m3u8DL-RE — registered if binary is on PATH or BIN_DIR
    from src.binaries import resolve_binary

    if resolve_binary("N_m3u8DL-RE"):
        from src.engines.m3u8_client import M3u8Client

        register_engine("m3u8", M3u8Client())
