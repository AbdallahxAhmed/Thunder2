"""Yanfaa platform engine.

Implements ``EngineProtocol``.  Fetches course metadata from the Yanfaa API,
resolves Brightcove video URLs, and delegates downloads to Thunder's existing
``ytdlp`` engine.
"""

from __future__ import annotations

import json
import logging
import os
import random
import string
from typing import Optional

import requests

from src.config import settings
from src.models import DownloadJob, DownloadRequest

logger = logging.getLogger(__name__)


class YanfaaEngine:
    """Yanfaa course downloader — API client + Brightcove resolver."""

    BASE_URL = "https://app.yanfaa.com/api"
    BRIGHTCOVE_ACCOUNT = "6164421959001"
    BRIGHTCOVE_POLICY_KEY = (
        "BCpkADawqM1cc7mSqFcl5YPsKmHHQVVn_PTFxPqbfFOOvYVNWaLB6E4VJR7el0d4bfVzJnYLlkPXblFY3cLhGuJnfPLFYJ"
        "-YtPr8MUzG-4FnvzVdnbIqMm1Nqm1SixyKr1PsT_xOGsN_Kk8P"
    )

    def __init__(self) -> None:
        self._session: Optional[requests.Session] = None
        self._token: Optional[str] = None

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Not used for batch — see the ``/api/yanfaa/*`` endpoints."""
        return {"status": "failed", "error": "Use /api/yanfaa/* endpoints directly"}

    # ── Auth ──────────────────────────────────────────────────────────

    def _get_session(self) -> requests.Session:
        """Lazy-initialise an authenticated session."""
        if self._session is not None:
            return self._session

        self._session = requests.Session()
        self._load_auth()
        return self._session

    def _load_auth(self) -> None:
        """Load Yanfaa auth from data directory."""
        auth_file = os.path.join(settings.course_data_dir, "yanfaa_auth.json")
        if not os.path.exists(auth_file):
            logger.warning("Yanfaa auth file not found: %s", auth_file)
            return

        try:
            with open(auth_file, "r", encoding="utf-8") as f:
                auth = json.load(f)
        except Exception as exc:
            logger.error("Failed to load Yanfaa auth: %s", exc)
            return

        # Token from localStorage
        local_storage = auth.get("local_storage", {})
        self._token = local_storage.get("token", "").strip('"')

        # Fallback: token from cookies
        if not self._token:
            for cookie in auth.get("cookies", []):
                if "token" in cookie.get("name", "").lower():
                    self._token = cookie.get("value", "")
                    break

        if self._token:
            session_id = "".join(random.choices(string.ascii_letters + string.digits, k=40))
            self._session.headers.update({
                "Authorization": f"Bearer {self._token}",
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "ar",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://yanfaa.com/",
                "Origin": "https://yanfaa.com",
                "X-Session-ID": session_id,
            })
            logger.info("Yanfaa auth loaded successfully", extra={"event": "yanfaa.auth_loaded"})

    @property
    def is_authenticated(self) -> bool:
        self._get_session()
        return bool(self._token)

    # ── API ───────────────────────────────────────────────────────────

    def get_course(self, course_slug: str) -> dict:
        """Fetch course metadata by slug."""
        session = self._get_session()
        session_id = "".join(random.choices(string.ascii_letters + string.digits, k=40))
        url = f"{self.BASE_URL}/course/{course_slug}"
        resp = session.get(url, params={"session_id": session_id})
        resp.raise_for_status()
        return resp.json()

    def get_video_url(self, brightcove_id: str) -> Optional[str]:
        """Resolve a Brightcove video ID to a playable URL (HLS > DASH > MP4)."""
        url = (
            f"https://edge.api.brightcove.com/playback/v1/accounts/"
            f"{self.BRIGHTCOVE_ACCOUNT}/videos/{brightcove_id}"
        )
        headers = {
            "Accept": f"application/json;pk={self.BRIGHTCOVE_POLICY_KEY}",
            "Origin": "https://yanfaa.com",
            "Referer": "https://yanfaa.com/",
        }
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code != 200:
            logger.warning(
                "Brightcove API returned %d for video %s",
                resp.status_code,
                brightcove_id,
                extra={"event": "yanfaa.brightcove_error"},
            )
            return None

        data = resp.json()
        hls_url = dash_url = mp4_url = None

        for source in data.get("sources", []):
            src = source.get("src", "")
            if ".m3u8" in src:
                hls_url = src
            elif ".mpd" in src:
                dash_url = src
            elif ".mp4" in src and source.get("container") == "MP4":
                if not mp4_url or source.get("height", 0) > 720:
                    mp4_url = src

        return hls_url or dash_url or mp4_url

    def extract_videos(self, course_data: dict) -> list[dict]:
        """Extract video list from course API response."""
        videos = []

        # Primary: top-level 'videos' array
        for v in course_data.get("videos", []):
            bc_id = v.get("brightcove_video_id") or v.get("brightcove_id")
            if bc_id:
                videos.append({
                    "index": len(videos),
                    "brightcove_id": str(bc_id),
                    "title": v.get("title", f"Video {len(videos) + 1}"),
                    "duration": v.get("duration", 0),
                    "duration_human": v.get("duration_human", ""),
                    "order": v.get("sort", len(videos)),
                })

        # Fallback: nested 'chapters' → lessons
        if not videos:
            for chapter in course_data.get("chapters", []):
                lessons = chapter.get("lessons", []) or chapter.get("videos", [])
                for lesson in lessons:
                    vid = lesson.get("brightcove_id") or lesson.get("video_id")
                    if vid:
                        videos.append({
                            "index": len(videos),
                            "brightcove_id": str(vid),
                            "title": lesson.get("title", f"Video {len(videos) + 1}"),
                            "duration": lesson.get("duration", 0),
                            "chapter": chapter.get("title", ""),
                            "order": len(videos),
                        })

        videos.sort(key=lambda x: x.get("order", 0))
        # Re-index after sort
        for i, v in enumerate(videos):
            v["index"] = i

        logger.info(
            "Yanfaa course: %d videos extracted",
            len(videos),
            extra={"event": "yanfaa.videos_extracted"},
        )
        return videos
