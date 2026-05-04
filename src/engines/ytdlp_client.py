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
        
        opts: dict[str, Any] = {
            "format": format_str,
            "outtmpl": os.path.join(
                os.path.abspath(self.download_dir), "%(title).200s.%(ext)s"
            ),
            "merge_output_format": "mp4",
            "quiet": True,
            "no_warnings": True,
        }
        return opts

    def _get_browser(self, user_agent: str | None) -> str:
        """Map the User-Agent to a known browser for yt-dlp cookie extraction."""
        ua = (user_agent or "").lower()
        if "firefox" in ua:
            return "firefox"
        if "edg" in ua:
            return "edge"
        return "chromium"

    def extract_info(
        self, url: str, *, cookies: list | None = None, user_agent: str | None = None
    ) -> dict:
        """Fetch available formats without downloading."""
        opts: dict[str, Any] = {"quiet": True, "no_warnings": True}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=False)

            # Detect anti-bot: extraction succeeds but formats are stripped
            video_formats = [
                f for f in (info or {}).get("formats", [])
                if f.get("height") and (f.get("vcodec") or "") != "none"
            ]
            if not video_formats:
                raise yt_dlp.utils.DownloadError(
                    "No video formats returned — likely auth-gated"
                )

            logger.debug("extract_info OK: %d video formats for %s", len(video_formats), url)
            return info
        except Exception as exc:
            exc_str = str(exc).lower()
            needs_auth = (
                "age" in exc_str
                or "sign in" in exc_str
                or "no video formats" in exc_str
                or "requested format" in exc_str
            )
            if needs_auth:
                logger.info("Retrying extraction with browser cookies for: %s", url)
                auth_opts: dict[str, Any] = {
                    "quiet": True,
                    "cookiesfrombrowser": (self._get_browser(user_agent),),
                    "extractor_args": {"youtube": ["client=IOS,ANDROID_VR", "player_client=ios,android"]},
                    "remote_components": ["ejs:github"],
                }
                with yt_dlp.YoutubeDL(auth_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                all_formats = (info or {}).get("formats", [])
                if all_formats:
                    sample = all_formats[0]
                    logger.info(
                        "[THUNDER] Sample format: height=%s vcodec=%s acodec=%s protocol=%s has_url=%s",
                        sample.get("height"), sample.get("vcodec"), sample.get("acodec"),
                        sample.get("protocol"), bool(sample.get("url") or sample.get("manifest_url")),
                    )
                auth_formats = [
                    f for f in all_formats
                    if f.get("height") and (f.get("vcodec") or "") != "none"
                ]
                logger.info(
                    "Authenticated extraction: %d total, %d video formats for %s",
                    len(all_formats), len(auth_formats), url,
                )
                if not auth_formats:
                    logger.error("[THUNDER] Authenticated extraction STILL returned 0 video formats. Aborting.")
                    raise yt_dlp.utils.DownloadError("Authenticated extraction returned no video formats")
                return info
            raise

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

        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                ydl.download([request.url])

            return {
                "status": "completed",
                "output_path": os.path.abspath(self.download_dir),
                "file_size": None,
            }
        except Exception as exc:
            exc_str = str(exc).lower()
            needs_auth = (
                "age" in exc_str
                or "sign in" in exc_str
                or "no video formats" in exc_str
                or "requested format" in exc_str
            )
            if needs_auth:
                logger.info("Retrying download with browser cookies for: %s", request.url)
                opts["cookiesfrombrowser"] = (self._get_browser(request.user_agent),)
                opts["extractor_args"] = {"youtube": ["client=IOS,ANDROID_VR", "player_client=ios,android"]}
                opts["format"] = "bestvideo+bestaudio/best"
                opts["remote_components"] = ["ejs:github"]
                opts.pop("no_warnings", None)
                try:
                    with yt_dlp.YoutubeDL(opts) as ydl:
                        ydl.download([request.url])

                    return {
                        "status": "completed",
                        "output_path": os.path.abspath(self.download_dir),
                        "file_size": None,
                    }
                except Exception as retry_exc:
                    exc = retry_exc

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
