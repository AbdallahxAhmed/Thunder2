"""N_m3u8DL-RE engine client — handles DRM-encrypted HLS/DASH streams.

Invoked via ``subprocess.run()`` per constitution Principle III.
Runs synchronously and must be called via ``asyncio.to_thread()``.
"""

from __future__ import annotations

import hashlib
import logging
import os
import subprocess
from typing import Any

from src.config import settings
from src.models import DownloadJob, DownloadRequest

logger = logging.getLogger(__name__)


class M3u8Client:
    """Wrapper around the N_m3u8DL-RE binary."""

    def __init__(self, download_dir: str | None = None) -> None:
        self.download_dir = download_dir or settings.download_dir

    def _generate_save_name(self, url: str) -> str:
        """Generate a filesystem-safe name from the URL."""
        # Use a short hash of the URL as the filename to avoid special chars
        url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
        return f"drm_{url_hash}"

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Run a DRM download end-to-end (blocking).

        Constructs and runs the N_m3u8DL-RE command, captures output,
        and returns a result dict.
        """
        save_dir = os.path.abspath(self.download_dir)
        save_name = self._generate_save_name(request.url)

        cmd: list[str] = [
            "N_m3u8DL-RE",
            request.url,
            "--save-dir", save_dir,
            "--save-name", save_name,
            "--auto-select",
            "--del-after-done",
        ]

        # Add --key only if drm_keys are provided
        if request.drm_keys:
            cmd.extend(["--key", request.drm_keys])
        else:
            logger.warning(
                "N_m3u8DL-RE invoked without drm_keys for %s — decryption may fail",
                request.url,
                extra={
                    "download_id": job.id,
                    "engine": "m3u8",
                    "event": "download.warning",
                },
            )

        logger.info(
            "N_m3u8DL-RE starting: %s",
            job.id,
            extra={
                "download_id": job.id,
                "engine": "m3u8",
                "event": "download.started",
            },
        )

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=3600
            )

            # Log captured output
            if result.stdout:
                logger.debug(
                    "N_m3u8DL-RE stdout: %s",
                    result.stdout[:2000],
                    extra={"download_id": job.id, "engine": "m3u8"},
                )
            if result.stderr:
                logger.debug(
                    "N_m3u8DL-RE stderr: %s",
                    result.stderr[:2000],
                    extra={"download_id": job.id, "engine": "m3u8"},
                )

            if result.returncode == 0:
                # Look for output file
                output_path = os.path.join(save_dir, save_name)
                # N_m3u8DL-RE may append an extension
                for ext in (".mp4", ".mkv", ".ts"):
                    candidate = output_path + ext
                    if os.path.exists(candidate):
                        output_path = candidate
                        break

                file_size = (
                    os.path.getsize(output_path)
                    if os.path.exists(output_path)
                    else None
                )

                logger.info(
                    "N_m3u8DL-RE completed: %s → %s",
                    job.id,
                    output_path,
                    extra={
                        "download_id": job.id,
                        "engine": "m3u8",
                        "event": "download.completed",
                    },
                )
                return {
                    "status": "completed",
                    "output_path": output_path,
                    "file_size": file_size,
                }
            else:
                error_msg = result.stderr.strip() or f"N_m3u8DL-RE exited with code {result.returncode}"
                logger.error(
                    "N_m3u8DL-RE failed: %s — %s",
                    job.id,
                    error_msg,
                    extra={
                        "download_id": job.id,
                        "engine": "m3u8",
                        "event": "download.failed",
                    },
                )
                return {"status": "failed", "error": error_msg}

        except subprocess.TimeoutExpired:
            error_msg = "N_m3u8DL-RE timed out after 3600 seconds"
            logger.error(
                error_msg,
                extra={
                    "download_id": job.id,
                    "engine": "m3u8",
                    "event": "download.failed",
                },
            )
            return {"status": "failed", "error": error_msg}
        except FileNotFoundError:
            error_msg = "N_m3u8DL-RE binary not found on PATH"
            logger.error(
                error_msg,
                extra={
                    "download_id": job.id,
                    "engine": "m3u8",
                    "event": "download.failed",
                },
            )
            return {"status": "failed", "error": error_msg}
