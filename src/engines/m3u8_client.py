"""N_m3u8DL-RE engine client — handles DRM-encrypted HLS/DASH streams.

Invoked via ``subprocess.run()`` per constitution Principle III.
Runs synchronously and must be called via ``asyncio.to_thread()``.

v2: Integrates with WidevineCDM for server-side key negotiation when
    PSSH + license_url are provided instead of pre-extracted drm_keys.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import subprocess
from typing import Any

from src.config import settings
from src.models import DownloadJob, DownloadRequest

logger = logging.getLogger(__name__)


class M3u8Client:
    """Wrapper around the N_m3u8DL-RE binary."""

    def __init__(self, download_dir: str | None = None) -> None:
        self.download_dir = download_dir or settings.download_dir

    def _sanitize_filename(self, name: str) -> str:
        """Strip invalid filesystem characters and truncate to safe length."""
        # Remove characters invalid on Windows/Linux/macOS
        clean = re.sub(r'[/\\:*?"<>|]', '', name)
        # Collapse whitespace
        clean = re.sub(r'\s+', ' ', clean).strip()
        # Truncate to 200 chars (excluding extension) per spec
        if len(clean) > 200:
            clean = clean[:200].strip()
        return clean

    def _generate_save_name(self, url: str, title: str | None = None) -> str:
        """Generate a filesystem-safe name from the title or URL."""
        if title:
            sanitized = self._sanitize_filename(title)
            if sanitized:
                return sanitized
        # Fallback: short hash of the URL
        url_hash = hashlib.md5(url.encode()).hexdigest()[:12]
        return f"drm_{url_hash}"

    def _resolve_keys(self, request: DownloadRequest) -> list[str]:
        """Resolve KID:KEY pairs — either from drm_keys or CDM negotiation.

        Returns a list of 'KID:KEY' strings.
        """
        # Path A: Pre-extracted keys supplied directly
        if request.drm_keys:
            keys = [
                pair.strip()
                for pair in request.drm_keys.split(",")
                if pair.strip()
            ]
            logger.info(
                "Using %d pre-extracted key(s)",
                len(keys),
                extra={"event": "keys.pre_extracted"},
            )
            return keys

        # Path B: CDM negotiation via pywidevine
        if request.pssh and request.license_url:
            from src.engines.widevine_cdm import widevine_cdm

            logger.info(
                "Negotiating keys via pywidevine for %s",
                request.license_url,
                extra={"event": "keys.cdm_negotiation"},
            )
            try:
                keys = widevine_cdm.negotiate_keys(
                    pssh_b64=request.pssh,
                    license_url=request.license_url,
                    license_headers=request.license_headers,
                    video_url=request.page_url or request.url,
                )
                return keys
            except Exception as exc:
                logger.error(
                    "CDM negotiation failed: %s",
                    exc,
                    extra={"event": "keys.cdm_failed"},
                )
                raise

        # No keys available
        return []

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Run a DRM download end-to-end (blocking).

        1. Resolve keys (pre-extracted or CDM negotiation)
        2. Build N_m3u8DL-RE command with --key flags
        3. Execute subprocess and capture output
        """
        save_dir = os.path.abspath(self.download_dir)
        save_name = self._generate_save_name(request.url, request.title)

        # ── Step 1: Resolve keys ──────────────────────────────────────
        try:
            keys = self._resolve_keys(request)
        except Exception as exc:
            error_msg = f"Key resolution failed: {exc}"
            logger.error(
                error_msg,
                extra={
                    "download_id": job.id,
                    "engine": "m3u8",
                    "event": "download.failed",
                },
            )
            return {"status": "failed", "error": error_msg}

        # ── Step 2: Build command ─────────────────────────────────────
        cmd: list[str] = [
            "N_m3u8DL-RE",
            request.url,
            "--save-dir", save_dir,
            "--save-name", save_name,
            "--auto-select",
            "--del-after-done",
            "--thread-count", "16",
            "-M", "format=mp4",  # Force mux audio+video into a single .mp4
        ]

        # ── Browser spoofing headers (anti-hotlinking bypass) ────────
        spoof_ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        cmd.extend(["-H", f"User-Agent: {spoof_ua}"])

        if request.page_url:
            cmd.extend(["-H", f"Referer: {request.page_url}"])
            try:
                from urllib.parse import urlparse
                parsed = urlparse(request.page_url)
                origin = f"{parsed.scheme}://{parsed.netloc}"
                cmd.extend(["-H", f"Origin: {origin}"])
            except Exception:
                pass

        if request.license_headers:
            for k, v in request.license_headers.items():
                if k.lower() not in ("content-length", "host", "content-type"):
                    cmd.extend(["-H", f"{k}: {v}"])

        # Add --key for each resolved key pair
        for key_pair in keys:
            cmd.extend(["--key", key_pair])

        if not keys:
            logger.warning(
                "N_m3u8DL-RE invoked without keys for %s — decryption will fail",
                request.url,
                extra={
                    "download_id": job.id,
                    "engine": "m3u8",
                    "event": "download.warning",
                },
            )

        redacted_cmd = []
        skip_next = False
        for arg in cmd:
            if skip_next:
                redacted_cmd.append("REDACTED")
                skip_next = False
            elif arg == "--key":
                redacted_cmd.append(arg)
                skip_next = True
            else:
                redacted_cmd.append(arg)

        logger.info(
            "N_m3u8DL-RE starting: %s with %d key(s) from %s",
            job.id,
            len(keys),
            request.license_url or "pre-extracted",
            extra={
                "download_id": job.id,
                "engine": "m3u8",
                "event": "download.started",
                "license_url": request.license_url,
                "cmd": redacted_cmd,
            },
        )

        # ── Step 3: Execute ───────────────────────────────────────────
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

