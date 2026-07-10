"""HAR-based course downloader engine.

Implements ``EngineProtocol``.  Extracts M3U8 URLs from HAR files and
creates child download jobs through Thunder's job manager, delegating
actual downloading to the existing ``m3u8`` or ``ytdlp`` engine.
"""

from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime
from typing import Optional

from src.config import settings
from src.models import DownloadJob, DownloadRequest

logger = logging.getLogger(__name__)

# Maximum seconds between a page load and its associated m3u8 request
MAX_TIME_DIFF = 300

IGNORE_FILES = {
    "settings.json", "cookies.json", "package.json",
    "tsconfig.json", "package-lock.json", "config.json",
}


class CourseHAREngine:
    """Extract M3U8 URLs from HAR files and coordinate batch downloads."""

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Not used for batch — see ``extract()`` and ``extract_and_download()``."""
        return {"status": "failed", "error": "Use /api/course/har/* endpoints directly"}

    # ── Public API ────────────────────────────────────────────────────

    @staticmethod
    def extract(har_path: str) -> dict:
        """Extract M3U8 URLs from a HAR file.

        Returns dict with keys: urls, names, missing_lessons, total_found.
        """
        if not os.path.exists(har_path):
            return {"error": f"HAR file not found: {har_path}", "urls": [], "names": [], "missing_lessons": [], "total_found": 0}

        try:
            with open(har_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            return {"error": str(exc), "urls": [], "names": [], "missing_lessons": [], "total_found": 0}

        log_data = data.get("log", {})

        # ── Build lesson page index ──────────────────────────────────
        pages_by_lesson: dict = {}
        seen_nums: set[int] = set()

        for page in log_data.get("pages", []):
            title = page.get("title", "")
            started = page.get("startedDateTime", "")
            match = re.search(r"/(\d+)-", title)
            if match:
                num = int(match.group(1))
                if num not in seen_nums:
                    seen_nums.add(num)
                    pages_by_lesson[num] = {"time": started, "title": title}
            elif "watch-list" in title.lower():
                pages_by_lesson[30.5] = {"time": started, "title": title}

        # ── Collect unique m3u8 URLs ─────────────────────────────────
        all_m3u8 = []
        seen_urls: set[str] = set()
        for entry in log_data.get("entries", []):
            url = entry.get("request", {}).get("url", "")
            if ".m3u8" in url and "playlist.m3u8" in url:
                entry_time = entry.get("startedDateTime", "")
                if entry_time and url not in seen_urls:
                    all_m3u8.append({"url": url, "time": entry_time})
                    seen_urls.add(url)

        # ── Match each m3u8 URL to its closest lesson page ───────────
        url_to_lesson: dict = {}
        for m in all_m3u8:
            m_time = datetime.fromisoformat(m["time"].replace("Z", "+00:00"))
            best_lesson = None
            min_diff: Optional[float] = None

            for lesson_num, page_info in pages_by_lesson.items():
                p_time = datetime.fromisoformat(page_info["time"].replace("Z", "+00:00"))
                diff = (m_time - p_time).total_seconds()
                if 0 <= diff <= MAX_TIME_DIFF:
                    if min_diff is None or diff < min_diff:
                        min_diff = diff
                        best_lesson = lesson_num

            if best_lesson is not None:
                if best_lesson in url_to_lesson:
                    existing = url_to_lesson[best_lesson]
                    ex_time = datetime.fromisoformat(existing["time"].replace("Z", "+00:00"))
                    ex_page_time = datetime.fromisoformat(pages_by_lesson[best_lesson]["time"].replace("Z", "+00:00"))
                    ex_diff = (ex_time - ex_page_time).total_seconds()
                    if min_diff < ex_diff:
                        url_to_lesson[best_lesson] = m
                else:
                    url_to_lesson[best_lesson] = m

        # ── Build sorted results ─────────────────────────────────────
        lesson_m3u8 = {
            num: {"url": m["url"], "title": pages_by_lesson[num]["title"]}
            for num, m in url_to_lesson.items()
        }

        sorted_lessons = sorted(lesson_m3u8.items(), key=lambda x: x[0])
        urls = [info["url"] for _, info in sorted_lessons]
        names = [info["title"].split("/")[-2] for _, info in sorted_lessons]

        all_nums = set(pages_by_lesson.keys())
        matched_nums = set(lesson_m3u8.keys())
        missing = sorted([int(x) for x in (all_nums - matched_nums) if x != 30.5])

        logger.info(
            "HAR extraction: %d URLs found, %d missing",
            len(urls),
            len(missing),
            extra={"event": "course_har.extracted"},
        )

        return {
            "urls": urls,
            "names": names,
            "missing_lessons": missing,
            "total_found": len(urls),
        }

    @staticmethod
    def find_har_files(directory: str = ".") -> list[dict]:
        """Find all valid HAR files in a directory."""
        results = []
        if not os.path.exists(directory):
            return results

        for filename in os.listdir(directory):
            full = os.path.join(directory, filename)
            if not os.path.isfile(full):
                continue
            if filename in IGNORE_FILES:
                continue
            if filename.endswith(".har") or filename.endswith(".json"):
                try:
                    with open(full, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if "log" in data and "entries" in data.get("log", {}):
                        entries = data["log"]["entries"]
                        has_m3u8 = any(".m3u8" in e.get("request", {}).get("url", "") for e in entries[:500])
                        pages = data["log"].get("pages", [])
                        has_lessons = any("lessons" in p.get("title", "").lower() for p in pages[:20])
                        if has_m3u8 or has_lessons:
                            results.append({
                                "path": full,
                                "size_mb": round(os.path.getsize(full) / (1024 * 1024), 1),
                            })
                except Exception:
                    continue

        return sorted(results, key=lambda x: x["path"])

    @staticmethod
    def load_cookies(data_dir: Optional[str] = None) -> dict:
        """Load simplified cookies from data directory."""
        data_dir = data_dir or settings.course_data_dir
        cookies_path = os.path.join(data_dir, "cookies.json")
        if not os.path.exists(cookies_path):
            return {}
        try:
            with open(cookies_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
            if isinstance(data, list):
                return {c["name"]: c["value"] for c in data}
        except Exception:
            pass
        return {}
