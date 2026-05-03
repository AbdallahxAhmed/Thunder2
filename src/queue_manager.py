"""Queue Manager for UHDD daemon.

Handles job persistence (SQLite), concurrency control, and state management.
Replaces the old in-memory job_manager.py.
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional

from src.models import DownloadStatus


@dataclass
class ActiveJobState:
    """In-memory representation of an active (non-terminal) download job."""
    job_id: str
    url: str
    engine: str
    status: DownloadStatus
    created_at: datetime
    updated_at: datetime
    progress: Optional[float] = None
    speed: Optional[str] = None
    eta: Optional[int] = None
    output_path: Optional[str] = None
    file_size: Optional[int] = None
    error: Optional[str] = None
    group_id: Optional[str] = None
    title: Optional[str] = None
    task: Optional[asyncio.Task] = None


class QueueManager:
    """Singleton managing the download queue, persistence, and scheduling."""

    def __init__(self, db_path: Optional[str] = None):
        self._db_path = db_path  # Will fallback to settings.db_path in db.py if None
        self._hot_cache: Dict[str, ActiveJobState] = {}
        self._lock = asyncio.Lock()

    async def init(self):
        """Initialize cache from SQLite. To be implemented in Batch B."""
        pass

    async def create_job(self, job_id: str, url: str, engine: str, **kwargs) -> ActiveJobState:
        """Create a job in cache (SQLite persistence in Batch B)."""
        async with self._lock:
            state = ActiveJobState(
                job_id=job_id,
                url=url,
                engine=engine,
                status=DownloadStatus.QUEUED,
                created_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
                **kwargs
            )
            self._hot_cache[job_id] = state
            return state

    async def get_job(self, job_id: str) -> Optional[ActiveJobState]:
        """Get job from cache (SQLite fallback in Batch B)."""
        async with self._lock:
            return self._hot_cache.get(job_id)

    async def update_job(self, job_id: str, **kwargs) -> Optional[ActiveJobState]:
        """Update job in cache (SQLite persistence in Batch B)."""
        async with self._lock:
            state = self._hot_cache.get(job_id)
            if not state:
                return None
            for k, v in kwargs.items():
                if hasattr(state, k):
                    setattr(state, k, v)
            state.updated_at = datetime.now(timezone.utc)
            return state

    async def list_jobs(self) -> list[ActiveJobState]:
        """List active jobs from cache."""
        async with self._lock:
            return list(self._hot_cache.values())

    async def delete_job(self, job_id: str):
        """Remove from cache."""
        async with self._lock:
            if job_id in self._hot_cache:
                del self._hot_cache[job_id]


# Global singleton instance
queue_manager = QueueManager()
