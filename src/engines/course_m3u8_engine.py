"""Batch M3U8 downloader with human-like scheduling.

Implements ``EngineProtocol``.  Accepts a list of M3U8 URLs and downloads
them sequentially with configurable random delays, delegating each individual
download to Thunder's existing ``m3u8`` or ``ytdlp`` engine via the job manager.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta
from random import randint, uniform
from typing import Optional

from src.config import settings
from src.models import DownloadJob, DownloadRequest, ScheduleConfig

logger = logging.getLogger(__name__)


class CourseM3U8Engine:
    """Batch M3U8 downloader with scheduling logic."""

    def execute(self, job: DownloadJob, request: DownloadRequest) -> dict:
        """Not used for batch — see the ``/api/course/m3u8/batch`` endpoint."""
        return {"status": "failed", "error": "Use /api/course/m3u8/batch endpoint directly"}


# ── Scheduling Utilities ──────────────────────────────────────────────────


def calculate_next_time(
    schedule: ScheduleConfig,
    last_time: Optional[datetime],
    videos_today: int,
) -> tuple[datetime, str]:
    """Calculate the next download time based on schedule rules."""
    now = datetime.now()

    if not last_time:
        if now.hour < schedule.start_hour:
            return now.replace(hour=schedule.start_hour, minute=0, second=0), "Starting at morning"
        if now.hour >= schedule.end_hour:
            tomorrow = now + timedelta(days=1)
            return tomorrow.replace(hour=schedule.start_hour, minute=0, second=0), "Too late, starting tomorrow"
        return now, "Starting now"

    if videos_today >= schedule.max_videos_per_day:
        tomorrow = now + timedelta(days=1)
        return tomorrow.replace(hour=schedule.start_hour, minute=0, second=0), f"Daily limit ({schedule.max_videos_per_day})"

    # Random wait: occasionally a long break
    if uniform(0, 1) < schedule.long_break_probability:
        wait = randint(schedule.long_break_min, schedule.long_break_max)
        reason = "Long break"
    else:
        wait = randint(schedule.min_wait_minutes, schedule.max_wait_minutes)
        reason = "Normal break"

    next_time = last_time + timedelta(minutes=wait)

    if next_time.hour >= schedule.end_hour or next_time.hour < schedule.start_hour:
        next_day = next_time + timedelta(days=1)
        next_time = next_day.replace(hour=schedule.start_hour, minute=0, second=0)
        reason = "Outside hours, resuming tomorrow"

    return next_time, reason


def get_default_schedule() -> ScheduleConfig:
    """Build a ScheduleConfig from Thunder's global settings."""
    return ScheduleConfig(
        min_wait_minutes=settings.schedule_min_wait,
        max_wait_minutes=settings.schedule_max_wait,
        start_hour=settings.schedule_start_hour,
        end_hour=settings.schedule_end_hour,
        max_videos_per_day=settings.schedule_max_daily,
    )


def generate_preview(
    video_names: list[str],
    schedule: ScheduleConfig,
    start_idx: int = 0,
    count: int = 10,
) -> list[dict]:
    """Generate a preview of the download schedule for the next N videos."""
    preview = []
    last_time: Optional[datetime] = None
    videos_count = 0

    for i in range(start_idx, min(start_idx + count, len(video_names))):
        next_time, reason = calculate_next_time(schedule, last_time, videos_count)

        wait_str = "Now"
        if last_time:
            delta = next_time - last_time
            wait_str = f"{int(delta.total_seconds() / 60)} min"

        preview.append({
            "index": i + 1,
            "name": video_names[i],
            "time": next_time.isoformat(),
            "wait": wait_str,
            "reason": reason,
        })

        last_time = next_time
        videos_count += 1
        if videos_count >= schedule.max_videos_per_day:
            videos_count = 0

    return preview
