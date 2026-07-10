"""Engine health-check utilities.

Checks run at startup and on-demand via ``GET /api/health``.
Each check is non-blocking (intended to be called via ``asyncio.to_thread``
for the subprocess / HTTP ones).
"""

from __future__ import annotations

import importlib
import logging
import shutil
from typing import Optional

import requests

from src.config import settings
from src.models import EngineHealth

logger = logging.getLogger(__name__)


def check_aria2() -> EngineHealth:
    """Ping the aria2 JSON-RPC endpoint."""
    try:
        payload = {
            "jsonrpc": "2.0",
            "id": "health-check",
            "method": "aria2.getVersion",
            "params": [f"token:{settings.aria2_rpc_secret}"]
            if settings.aria2_rpc_secret
            else [],
        }
        resp = requests.post(settings.aria2_rpc_url, json=payload, timeout=3)
        data = resp.json()
        if "result" in data:
            version = data["result"].get("version", "unknown")
            return EngineHealth(name="aria2", available=True, version=version)
        error_msg = data.get("error", {}).get("message", "Unknown RPC error")
        return EngineHealth(name="aria2", available=False, error=error_msg)
    except requests.ConnectionError:
        return EngineHealth(
            name="aria2",
            available=False,
            error=f"aria2 RPC unreachable at {settings.aria2_rpc_url}",
        )
    except Exception as exc:
        return EngineHealth(name="aria2", available=False, error=str(exc))


def check_ytdlp() -> EngineHealth:
    """Verify yt-dlp is importable and get its version."""
    try:
        mod = importlib.import_module("yt_dlp")
        version = getattr(mod, "version", None)
        if version:
            version_str = getattr(version, "__version__", str(version))
        else:
            version_str = "unknown"
        return EngineHealth(name="ytdlp", available=True, version=version_str)
    except ImportError:
        return EngineHealth(
            name="ytdlp",
            available=False,
            error="yt-dlp Python module is not installed",
        )
    except Exception as exc:
        return EngineHealth(name="ytdlp", available=False, error=str(exc))


def check_m3u8() -> EngineHealth:
    """Check if N_m3u8DL-RE binary is available on PATH."""
    path = shutil.which("N_m3u8DL-RE")
    if path:
        return EngineHealth(name="m3u8", available=True, version=None)
    return EngineHealth(
        name="m3u8",
        available=False,
        error="N_m3u8DL-RE binary not found on PATH",
    )


def check_course_har() -> EngineHealth:
    """CourseHAR engine — always available (pure Python)."""
    return EngineHealth(name="course_har", available=True, version="1.0")


def check_yanfaa() -> EngineHealth:
    """Yanfaa engine — check if auth is configured."""
    import os
    auth_file = os.path.join(settings.course_data_dir, "yanfaa_auth.json")
    has_auth = os.path.exists(auth_file)
    return EngineHealth(
        name="yanfaa",
        available=True,
        version="1.0",
        error=None if has_auth else "No yanfaa_auth.json found (login required)",
    )


def check_course_m3u8() -> EngineHealth:
    """CourseM3U8 engine — always available (delegates to m3u8/ytdlp)."""
    return EngineHealth(name="course_m3u8", available=True, version="1.0")


def check_all_engines() -> list[EngineHealth]:
    """Run all engine health checks and return results."""
    results = [
        check_aria2(),
        check_ytdlp(),
        check_m3u8(),
        check_course_har(),
        check_yanfaa(),
        check_course_m3u8(),
    ]
    for r in results:
        level = logging.INFO if r.available else logging.WARNING
        logger.log(
            level,
            "Engine %s: %s",
            r.name,
            "available" if r.available else r.error,
            extra={"engine": r.name, "event": "engine.health_check"},
        )
    return results

