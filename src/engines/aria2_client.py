"""aria2 JSON-RPC client for standard file downloads.

Communicates with a locally running ``aria2c`` daemon via HTTP POST
to the JSON-RPC 2.0 endpoint.  All calls are synchronous (``requests``)
and should be wrapped in ``asyncio.to_thread()`` by the caller.
"""

from __future__ import annotations

import logging
import os
from typing import Optional

import requests

from src.config import settings
from src.models import DownloadJob, DownloadRequest, DownloadStatus

logger = logging.getLogger(__name__)


class Aria2Client:
    """Thin wrapper around aria2's JSON-RPC interface."""

    def __init__(
        self,
        rpc_url: str | None = None,
        rpc_secret: str | None = None,
        download_dir: str | None = None,
    ) -> None:
        self.rpc_url = rpc_url or settings.aria2_rpc_url
        self.rpc_secret = rpc_secret or settings.aria2_rpc_secret
        self.download_dir = download_dir or settings.download_dir

    # ----- low-level RPC helpers -----

    def _rpc(self, method: str, params: list | None = None) -> dict:
        """Send a JSON-RPC 2.0 request and return the ``result`` field."""
        all_params: list = []
        if self.rpc_secret:
            all_params.append(f"token:{self.rpc_secret}")
        if params:
            all_params.extend(params)

        payload = {
            "jsonrpc": "2.0",
            "id": "thunder",
            "method": method,
            "params": all_params,
        }
        resp = requests.post(self.rpc_url, json=payload, timeout=10)
        data = resp.json()
        if "error" in data:
            raise RuntimeError(f"aria2 RPC error: {data['error']}")
        return data.get("result")

    # ----- public API -----

    def add_download(
        self,
        url: str,
        user_agent: str | None = None,
        cookies: str | None = None,
        referer: str | None = None,
    ) -> str:
        """Submit a new download and return the aria2 GID."""
        options: dict[str, str] = {
            "split": "16",
            "max-connection-per-server": "16",
            "min-split-size": "1M",
            "dir": os.path.abspath(self.download_dir),
        }
        if user_agent:
            options["user-agent"] = user_agent
        if cookies:
            options["header"] = f"Cookie: {cookies}"
        if referer:
            options["referer"] = referer

        gid = self._rpc("aria2.addUri", [[url], options])
        logger.info(
            "aria2 download queued: gid=%s url=%s",
            gid,
            url,
            extra={"event": "download.started", "engine": "aria2"},
        )
        return gid

    def get_status(self, gid: str) -> dict:
        """Poll the status of a download by GID."""
        return self._rpc(
            "aria2.tellStatus",
            [gid, ["gid", "status", "totalLength", "completedLength",
                    "downloadSpeed", "files"]],
        )

    def remove_download(self, gid: str) -> str:
        """Cancel an active download."""
        return self._rpc("aria2.remove", [gid])

    # ----- engine protocol -----

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Run a download end-to-end (blocking — call via ``to_thread``)."""
        gid = self.add_download(
            url=request.url,
            user_agent=request.user_agent,
            cookies=request.cookies,
            referer=getattr(request, 'referer', None),
        )

        # Poll until completion
        import time

        while True:
            status = self.get_status(gid)
            aria2_status = status.get("status", "")

            if aria2_status == "complete":
                files = status.get("files", [])
                output_path = files[0]["path"] if files else None
                total = int(status.get("totalLength", 0))
                return {
                    "status": "completed",
                    "output_path": output_path,
                    "file_size": total,
                    "gid": gid,
                }
            elif aria2_status == "error":
                return {
                    "status": "failed",
                    "error": f"aria2 download failed (gid={gid})",
                    "gid": gid,
                }
            elif aria2_status == "removed":
                return {
                    "status": "failed",
                    "error": f"aria2 download cancelled (gid={gid})",
                    "gid": gid,
                }

            # Still active — update progress
            total = int(status.get("totalLength", 0))
            completed = int(status.get("completedLength", 0))
            speed = int(status.get("downloadSpeed", 0))

            progress = (completed / total * 100.0) if total > 0 else 0.0
            speed_str = f"{speed / 1_048_576:.1f} MB/s" if speed > 0 else None

            # These will be picked up by the orchestrator
            job.progress = progress
            job.speed = speed_str
            job.aria2_gid = gid

            time.sleep(1)
