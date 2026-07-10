"""yt-dlp engine client — downloads media via the yt_dlp Python module.

Uses ``yt_dlp.YoutubeDL`` directly (no subprocess). Runs synchronously
and must be called via ``asyncio.to_thread()`` from the orchestrator.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import yt_dlp

from src.config import settings
from src.models import DownloadJob, DownloadRequest

logger = logging.getLogger(__name__)


class YtdlpClient:
    """Thin wrapper around yt-dlp's YoutubeDL class."""

    def __init__(self, download_dir: str | None = None) -> None:
        self.download_dir = download_dir or settings.download_dir

    def _build_opts(self, request: DownloadRequest) -> dict[str, Any]:
        """Construct the yt-dlp options dict from a download request."""
        format_str = request.format_id if getattr(request, 'format_id', None) else "bestvideo+bestaudio/best"
        
        target_dir = getattr(request, 'download_dir', None) or self.download_dir
        
        title_tmpl = "%(title).200s"
        if getattr(request, "title", None) and request.title.strip():
            # Escape percent signs to prevent yt-dlp from parsing them as template fields
            title_tmpl = request.title.strip().replace("%", "%%")

        opts: dict[str, Any] = {
            "format": format_str,
            "outtmpl": os.path.join(
                os.path.abspath(target_dir), f"{title_tmpl}.%(ext)s"
            ),
            "merge_output_format": "mp4",
            "quiet": True,
            "no_warnings": True,
        }

        # Forward custom headers
        headers: dict[str, str] = {}
        if request.user_agent:
            headers["User-Agent"] = request.user_agent
        if headers:
            opts["http_headers"] = headers

        # Forward cookies as a header string (yt-dlp also supports cookiefile)
        if request.cookies:
            opts.setdefault("http_headers", {})["Cookie"] = request.cookies

        return opts

    def extract_info(self, url: str, cookies: Any | None = None, user_agent: str | None = None) -> dict:
        """Fetch available formats without downloading."""
        opts: dict[str, Any] = {"quiet": True, "no_warnings": True}
        headers: dict[str, str] = {}
        if user_agent:
            headers["User-Agent"] = user_agent
            
        if cookies:
            if isinstance(cookies, str):
                headers["Cookie"] = cookies
            elif isinstance(cookies, list):
                # Chrome cookie objects list
                cookie_str = "; ".join(f"{c['name']}={c['value']}" for c in cookies if 'name' in c and 'value' in c)
                headers["Cookie"] = cookie_str
                
        if headers:
            opts["http_headers"] = headers

        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Run a media download end-to-end (blocking).

        Returns a result dict with ``status``, ``output_path``, and
        optionally ``error``.
        """
        opts = self._build_opts(request)

        # Progress hook to update job progress
        def _progress_hook(d: dict) -> None:
            if d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
                downloaded = d.get("downloaded_bytes", 0)
                if total > 0:
                    job.progress = round(downloaded / total * 100, 1)
                speed = d.get("speed")
                if speed:
                    job.speed = f"{speed / 1_048_576:.1f} MB/s"
                logger.debug(
                    "yt-dlp progress: %.1f%%",
                    job.progress or 0,
                    extra={
                        "download_id": job.id,
                        "engine": "ytdlp",
                        "event": "download.progress",
                    },
                )
            elif d.get("status") == "finished":
                job.progress = 100.0
                logger.info(
                    "yt-dlp extraction finished: %s",
                    d.get("filename", ""),
                    extra={
                        "download_id": job.id,
                        "engine": "ytdlp",
                        "event": "download.progress",
                    },
                )

        opts["progress_hooks"] = [_progress_hook]

        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([request.url])

            # Determine output file — yt-dlp doesn't return it directly,
            # so we rely on the outtmpl + the last progress hook filename
            target_dir = getattr(request, 'download_dir', None) or self.download_dir
            return {
                "status": "completed",
                "output_path": os.path.abspath(target_dir),
                "file_size": None,  # not trivially available
            }
        except Exception as exc:
            logger.error(
                "yt-dlp failed: %s",
                exc,
                extra={
                    "download_id": job.id,
                    "engine": "ytdlp",
                    "event": "download.failed",
                },
            )
            return {"status": "failed", "error": str(exc)}
