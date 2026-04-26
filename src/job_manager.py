"""In-memory download job tracking with async-safe state management."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from src.models import DownloadJob, DownloadStatus

logger = logging.getLogger(__name__)


class JobManager:
    """Thread-safe, async-safe in-memory job store.

    All mutations go through ``asyncio.Lock`` so concurrent tasks
    cannot corrupt state.
    """

    def __init__(self) -> None:
        self._jobs: dict[str, DownloadJob] = {}
        self._lock = asyncio.Lock()

    async def create_job(self, url: str, engine: str) -> DownloadJob:
        """Create a new download job and return it."""
        job = DownloadJob(
            id=str(uuid.uuid4()),
            url=url,
            engine=engine,
            status=DownloadStatus.QUEUED,
        )
        async with self._lock:
            self._jobs[job.id] = job
        logger.info(
            "Job created: %s → %s",
            job.id,
            engine,
            extra={"download_id": job.id, "engine": engine, "event": "download.queued"},
        )
        return job

    async def get_job(self, job_id: str) -> Optional[DownloadJob]:
        """Return a job by ID or ``None`` if not found."""
        async with self._lock:
            return self._jobs.get(job_id)

    async def update_job(self, job_id: str, **fields: object) -> Optional[DownloadJob]:
        """Update specific fields on an existing job.

        Returns the updated job, or ``None`` if the ID is unknown.
        """
        async with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            for key, value in fields.items():
                if hasattr(job, key):
                    setattr(job, key, value)
            job.updated_at = datetime.now(timezone.utc)
            return job

    async def list_jobs(self) -> list[DownloadJob]:
        """Return a snapshot of all jobs."""
        async with self._lock:
            return list(self._jobs.values())


# Singleton — import this instance throughout the application
job_manager = JobManager()
