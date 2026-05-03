"""Queue Manager for UHDD daemon.

Handles job persistence (SQLite), concurrency control, and state management.
Replaces the old in-memory job_manager.py.
"""

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Dict, Optional, List, Any

from src.models import DownloadStatus
from src.db import get_db, init_db


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
        """Initialize database and load non-terminal jobs into Hot Cache."""
        await init_db(self._db_path)
        async with get_db(self._db_path) as db:
            cursor = await db.execute(
                "SELECT * FROM jobs WHERE status NOT IN (?, ?)",
                (DownloadStatus.COMPLETED.value, DownloadStatus.CANCELLED.value)
            )
            rows = await cursor.fetchall()
            for row in rows:
                state = ActiveJobState(
                    job_id=row["id"],
                    url=row["url"],
                    engine=row["engine"],
                    status=DownloadStatus(row["status"]),
                    created_at=datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")),
                    updated_at=datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")),
                    progress=row["progress"],
                    speed=row["speed"],
                    eta=row["eta"],
                    output_path=row["output_path"],
                    file_size=row["file_size"],
                    error=row["error"],
                    group_id=row["group_id"],
                    title=row["title"]
                )
                self._hot_cache[state.job_id] = state

    async def create_job(self, job_id: str, url: str, engine: str, **kwargs) -> ActiveJobState:
        """Create a job in SQLite and add to Hot Cache."""
        now = datetime.now(timezone.utc)
        
        db_kwargs = {k: v for k, v in kwargs.items() if k not in ["task"]}
        
        async with self._lock:
            async with get_db(self._db_path) as db:
                columns = ["id", "url", "engine", "status", "created_at", "updated_at"]
                values = [job_id, url, engine, DownloadStatus.QUEUED.value, now.isoformat().replace("+00:00", "Z"), now.isoformat().replace("+00:00", "Z")]
                
                for k, v in db_kwargs.items():
                    columns.append(k)
                    values.append(v)
                    
                placeholders = ", ".join(["?"] * len(columns))
                query = f"INSERT INTO jobs ({', '.join(columns)}) VALUES ({placeholders})"
                
                await db.execute(query, tuple(values))
                await db.commit()

            state = ActiveJobState(
                job_id=job_id,
                url=url,
                engine=engine,
                status=DownloadStatus.QUEUED,
                created_at=now,
                updated_at=now,
                **kwargs
            )
            self._hot_cache[job_id] = state
            return state

    async def get_job(self, job_id: str) -> Optional[ActiveJobState]:
        """Get job from Hot Cache, fallback to SQLite for terminal jobs."""
        async with self._lock:
            if job_id in self._hot_cache:
                return self._hot_cache[job_id]
                
            async with get_db(self._db_path) as db:
                cursor = await db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
                row = await cursor.fetchone()
                if not row:
                    return None
                    
                return ActiveJobState(
                    job_id=row["id"],
                    url=row["url"],
                    engine=row["engine"],
                    status=DownloadStatus(row["status"]),
                    created_at=datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")),
                    updated_at=datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")),
                    progress=row["progress"],
                    speed=row["speed"],
                    eta=row["eta"],
                    output_path=row["output_path"],
                    file_size=row["file_size"],
                    error=row["error"],
                    group_id=row["group_id"],
                    title=row["title"]
                )

    async def update_job(self, job_id: str, **kwargs) -> Optional[ActiveJobState]:
        """Update job in cache and optionally SQLite.
        
        Only writes to SQLite if state transitions, errors, or file output details change.
        High-frequency progress updates are Hot Cache only.
        """
        async with self._lock:
            state = self._hot_cache.get(job_id)
            if not state:
                state = await self.get_job(job_id)
                if not state:
                    return None
                    
            now = datetime.now(timezone.utc)
            
            # Identify if we need a SQLite write
            db_write_required = False
            sqlite_fields = ["status", "error", "output_path", "file_size", "group_id", "title"]
            db_updates = {}
            
            for k, v in kwargs.items():
                if hasattr(state, k):
                    setattr(state, k, v)
                if k in sqlite_fields:
                    db_write_required = True
                    db_updates[k] = v.value if isinstance(v, DownloadStatus) else v
                    
            state.updated_at = now
            
            if db_write_required:
                db_updates["updated_at"] = now.isoformat().replace("+00:00", "Z")
                set_clause = ", ".join([f"{k} = ?" for k in db_updates.keys()])
                values = list(db_updates.values()) + [job_id]
                
                async with get_db(self._db_path) as db:
                    await db.execute(f"UPDATE jobs SET {set_clause} WHERE id = ?", tuple(values))
                    await db.commit()
                    
            # Terminal states should be removed from Hot Cache
            if state.status in (DownloadStatus.COMPLETED, DownloadStatus.CANCELLED) and job_id in self._hot_cache:
                # But wait, the spec says terminal jobs are removed from cache.
                del self._hot_cache[job_id]
                
            return state

    async def list_jobs(self, limit: int = 50, offset: int = 0, status: Optional[str] = None, engine: Optional[str] = None, group_id: Optional[str] = None) -> List[ActiveJobState]:
        """List active jobs from cache and database."""
        async with self._lock:
            query = "SELECT * FROM jobs WHERE 1=1"
            params = []
            
            if status:
                query += " AND status = ?"
                params.append(status)
            if engine:
                query += " AND engine = ?"
                params.append(engine)
            if group_id:
                query += " AND group_id = ?"
                params.append(group_id)
                
            query += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
            params.extend([limit, offset])
            
            async with get_db(self._db_path) as db:
                cursor = await db.execute(query, tuple(params))
                rows = await cursor.fetchall()
                
            results = []
            for row in rows:
                job_id = row["id"]
                # Use Hot Cache if available for volatile fields
                if job_id in self._hot_cache:
                    results.append(self._hot_cache[job_id])
                else:
                    results.append(ActiveJobState(
                        job_id=job_id,
                        url=row["url"],
                        engine=row["engine"],
                        status=DownloadStatus(row["status"]),
                        created_at=datetime.fromisoformat(row["created_at"].replace("Z", "+00:00")),
                        updated_at=datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00")),
                        progress=row["progress"],
                        speed=row["speed"],
                        eta=row["eta"],
                        output_path=row["output_path"],
                        file_size=row["file_size"],
                        error=row["error"],
                        group_id=row["group_id"],
                        title=row["title"]
                    ))
            return results

    async def delete_job(self, job_id: str):
        """Remove from cache and SQLite."""
        async with self._lock:
            if job_id in self._hot_cache:
                del self._hot_cache[job_id]
                
            async with get_db(self._db_path) as db:
                await db.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
                await db.commit()


# Global singleton instance
queue_manager = QueueManager()
