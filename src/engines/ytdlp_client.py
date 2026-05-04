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
from src.cookies import write_cookie_file, cleanup_cookie_file
from src.models import DownloadJob, DownloadRequest

logger = logging.getLogger(__name__)


class YtdlpClient:
    """Thin wrapper around yt-dlp's YoutubeDL class."""

    def __init__(self, download_dir: str | None = None) -> None:
        self.download_dir = download_dir or settings.download_dir

    def _build_opts(self, request: DownloadRequest) -> dict[str, Any]:
        """Construct the yt-dlp options dict from a download request."""
        format_str = request.format_id if getattr(request, 'format_id', None) else "bestvideo+bestaudio/best"
        
        opts: dict[str, Any] = {
            "format": format_str,
            "outtmpl": os.path.join(
                os.path.abspath(self.download_dir), "%(title).200s.%(ext)s"
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

        # Write browser cookies to a Netscape cookie file
        if request.cookies:
            if isinstance(request.cookies, list):
                cookie_path = write_cookie_file(request.cookies)
                if cookie_path:
                    opts["cookiefile"] = cookie_path
            elif isinstance(request.cookies, str):
                # Legacy fallback: raw cookie header string
                opts.setdefault("http_headers", {})["Cookie"] = request.cookies

        return opts

    def extract_info(
        self, url: str, *, cookies: list | None = None, user_agent: str | None = None
    ) -> dict:
        """Fetch available formats without downloading."""
        opts: dict[str, Any] = {"quiet": True, "no_warnings": True}
        if user_agent:
            opts.setdefault("http_headers", {})["User-Agent"] = user_agent
        cookie_path = None
        if cookies:
            cookie_path = write_cookie_file(cookies)
            if cookie_path:
                opts["cookiefile"] = cookie_path
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                return ydl.extract_info(url, download=False)
        finally:
            cleanup_cookie_file(cookie_path)

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Run a media download end-to-end (blocking).

        Returns a result dict with ``status``, ``output_path``, and
        optionally ``error``.
        """
        opts = self._build_opts(request)

        # Progress hook to update job progress
        def _progress_hook(d: dict) -> None:
            if getattr(job, '_cancel_flag', False):
                raise InterruptedError("Job was cancelled by QueueManager")
                
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

        cookie_path = opts.get("cookiefile")
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([request.url])

            # Determine output file — yt-dlp doesn't return it directly,
            # so we rely on the outtmpl + the last progress hook filename
            return {
                "status": "completed",
                "output_path": os.path.abspath(self.download_dir),
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
        finally:
            cleanup_cookie_file(cookie_path)
