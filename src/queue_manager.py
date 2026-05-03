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
        self._queue_wakeup_event = asyncio.Event()
        self._scheduler_task: Optional[asyncio.Task] = None
        
        # Concurrency limits loaded from DB
        self._global_limit = 8
        self._engine_limits = {"aria2": 4, "ytdlp": 3, "m3u8": 2}

    async def _load_settings(self):
        """Read concurrency limits from settings table."""
        async with get_db(self._db_path) as db:
            cursor = await db.execute("SELECT key, value FROM settings WHERE key LIKE '%limit%' OR key = 'global_max_concurrent'")
            rows = await cursor.fetchall()
            
            for row in rows:
                key, val = row["key"], row["value"]
                if key == "global_max_concurrent":
                    self._global_limit = int(val)
                elif key.startswith("engine_limit_"):
                    engine = key.replace("engine_limit_", "")
                    self._engine_limits[engine] = int(val)

    async def init(self):
        """Initialize database and load non-terminal jobs into Hot Cache."""
        await init_db(self._db_path)
        await self._load_settings()
        
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

        # Start scheduler loop
        if not self._scheduler_task:
            self._scheduler_task = asyncio.create_task(self._scheduler_loop())
            self._queue_wakeup_event.set()

    def _count_active_slots(self) -> tuple[int, Dict[str, int]]:
        """Count DOWNLOADING jobs globally and per-engine."""
        global_active = 0
        engine_active = {"aria2": 0, "ytdlp": 0, "m3u8": 0}
        
        for state in self._hot_cache.values():
            if state.status == DownloadStatus.DOWNLOADING:
                global_active += 1
                if state.engine in engine_active:
                    engine_active[state.engine] += 1
                    
        return global_active, engine_active

    async def _execute_download(self, job_id: str):
        """Placeholder for Phase 5 engine execution."""
        await self.update_job(job_id, status=DownloadStatus.DOWNLOADING)

    async def _promote_next(self):
        """Query QUEUED jobs and promote them up to available slots."""
        # Reload settings just in case they changed
        await self._load_settings()
        
        async with self._lock:
            global_active, engine_active = self._count_active_slots()
            
            if global_active >= self._global_limit:
                return []
                
            async with get_db(self._db_path) as db:
                cursor = await db.execute(
                    "SELECT id, engine FROM jobs WHERE status = ? ORDER BY priority DESC, created_at ASC",
                    (DownloadStatus.QUEUED.value,)
                )
                queued_jobs = await cursor.fetchall()

        # Execute promotions outside the lock to avoid deadlocks when update_job is called
        jobs_to_promote = []
        for row in queued_jobs:
            if global_active >= self._global_limit:
                break
                
            job_id = row["id"]
            engine = row["engine"]
            
            engine_limit = self._engine_limits.get(engine, 0)
            if engine_active.get(engine, 0) >= engine_limit:
                continue
                
            jobs_to_promote.append(job_id)
            global_active += 1
            if engine in engine_active:
                engine_active[engine] += 1
                
        for job_id in jobs_to_promote:
            state = await self.get_job(job_id)
            if state and state.status == DownloadStatus.QUEUED:
                await self._execute_download(job_id)

    async def _scheduler_loop(self):
        """Background task evaluating the queue."""
        while True:
            await self._queue_wakeup_event.wait()
            self._queue_wakeup_event.clear()
            try:
                await self._promote_next()
            except asyncio.CancelledError:
                break
            except Exception:
                # In production, we'd log this.
                pass

    async def _on_job_finished(self):
        """Called when a job reaches a terminal/paused state."""
        self._queue_wakeup_event.set()

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
            
        self._queue_wakeup_event.set()
        return state

    async def get_job(self, job_id: str) -> Optional[ActiveJobState]:
        """Get job from Hot Cache, fallback to SQLite for terminal jobs."""
        async with self._lock:
            return await self._get_job_unlocked(job_id)

    async def _get_job_unlocked(self, job_id: str) -> Optional[ActiveJobState]:
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
                state = await self._get_job_unlocked(job_id)
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
                del self._hot_cache[job_id]
                
        # Trigger scheduler if state changed to a terminal/paused state
        if db_write_required and "status" in db_updates:
            new_status = db_updates["status"]
            if new_status in (DownloadStatus.COMPLETED.value, DownloadStatus.FAILED.value, DownloadStatus.PAUSED.value, DownloadStatus.CANCELLED.value):
                await self._on_job_finished()
            elif new_status == DownloadStatus.QUEUED.value:
                self._queue_wakeup_event.set()
                
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

    async def shutdown(self):
        """Shutdown the background scheduler task."""
        if self._scheduler_task:
            self._scheduler_task.cancel()
            try:
                await self._scheduler_task
            except asyncio.CancelledError:
                pass
            self._scheduler_task = None

# Global singleton instance
queue_manager = QueueManager()
