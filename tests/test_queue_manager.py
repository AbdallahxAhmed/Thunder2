"""Tests for the QueueManager Hot Cache and SQLite persistence."""

import asyncio
import os
from datetime import datetime, timezone
from uuid import uuid4

import pytest

from src.models import DownloadStatus
from src.queue_manager import QueueManager, ActiveJobState
from src.db import init_db


@pytest.fixture
async def qm(tmp_path):
    """Return a fresh QueueManager instance for each test, with DB initialized."""
    db_path = str(tmp_path / "test_thunder.db")
    await init_db(db_path)
    qm_instance = QueueManager(db_path=db_path)
    await qm_instance.init()
    yield qm_instance
    await qm_instance.shutdown()


@pytest.mark.asyncio
async def test_create_and_get_job(qm):
    """Test creating a job and retrieving it from SQLite/Hot Cache."""
    job_id = str(uuid4())
    state = await qm.create_job(job_id, "https://example.com", "aria2")
    
    assert state.job_id == job_id
    assert state.status == DownloadStatus.QUEUED
    assert state.engine == "aria2"

    retrieved = await qm.get_job(job_id)
    assert retrieved is not None
    assert retrieved.job_id == job_id


@pytest.mark.asyncio
async def test_update_job(qm):
    """Test updating job progress and status."""
    job_id = str(uuid4())
    await qm.create_job(job_id, "https://example.com", "ytdlp")
    
    # Progress update (cache only)
    updated = await qm.update_job(job_id, progress=50.5, speed="10 MB/s")
    assert updated.progress == 50.5
    assert updated.speed == "10 MB/s"
    assert updated.status == DownloadStatus.QUEUED

    # Status update (writes to DB)
    updated_status = await qm.update_job(job_id, status=DownloadStatus.DOWNLOADING)
    assert updated_status.status == DownloadStatus.DOWNLOADING

    retrieved = await qm.get_job(job_id)
    assert retrieved.progress == 50.5
    assert retrieved.status == DownloadStatus.DOWNLOADING


@pytest.mark.asyncio
async def test_list_and_delete_jobs(qm):
    """Test listing and deleting jobs."""
    job1 = str(uuid4())
    job2 = str(uuid4())
    
    await qm.create_job(job1, "https://example.com/1", "aria2")
    await qm.create_job(job2, "https://example.com/2", "m3u8")
    
    jobs = await qm.list_jobs()
    assert len(jobs) == 2
    
    await qm.delete_job(job1)
    jobs_after = await qm.list_jobs()
    assert len(jobs_after) == 1
    assert jobs_after[0].job_id == job2


@pytest.mark.asyncio
async def test_terminal_jobs_removed_from_cache(qm):
    """Test that COMPLETED and CANCELLED jobs are removed from Hot Cache."""
    job_id = str(uuid4())
    await qm.create_job(job_id, "https://example.com", "ytdlp")
    
    assert job_id in qm._hot_cache
    
    # Complete job
    await qm.update_job(job_id, status=DownloadStatus.COMPLETED)
    
    # Should be removed from cache, but still retrievable from SQLite
    assert job_id not in qm._hot_cache
    
    retrieved = await qm.get_job(job_id)
    assert retrieved is not None
    assert retrieved.status == DownloadStatus.COMPLETED


@pytest.mark.asyncio
async def test_init_loads_non_terminal_jobs(tmp_path):
    """Test that init() loads only non-terminal jobs into cache."""
    db_path = str(tmp_path / "test_thunder.db")
    await init_db(db_path)
    qm1 = QueueManager(db_path=db_path)
    
    job1 = str(uuid4())
    job2 = str(uuid4())
    job3 = str(uuid4())
    
    await qm1.create_job(job1, "https://example.com", "aria2")
    await qm1.update_job(job1, status=DownloadStatus.QUEUED)
    
    await qm1.create_job(job2, "https://example.com", "aria2")
    await qm1.update_job(job2, status=DownloadStatus.DOWNLOADING)
    
    await qm1.create_job(job3, "https://example.com", "aria2")
    await qm1.update_job(job3, status=DownloadStatus.COMPLETED)
    
    # New instance representing a restart
    qm2 = QueueManager(db_path=db_path)
    await qm2.init()
    
    # Only QUEUED and DOWNLOADING should be in cache
    assert job1 in qm2._hot_cache
    assert job2 in qm2._hot_cache
    assert job3 not in qm2._hot_cache
    
    # All 3 should be in database
    jobs = await qm2.list_jobs()
    assert len(jobs) == 3
    
    await qm1.shutdown()
    await qm2.shutdown()


@pytest.mark.asyncio
async def test_scheduler_slot_counting_and_promotion(qm):
    """Test that jobs are automatically promoted to DOWNLOADING up to the limit."""
    # The default test DB limits are aria2: 4
    jobs = []
    for _ in range(5):
        job_id = str(uuid4())
        await qm.create_job(job_id, "https://example.com", "aria2")
        jobs.append(job_id)
        
    # Yield to let scheduler loop run
    await asyncio.sleep(0.1)
    
    # Check states
    downloading = 0
    queued = 0
    for job_id in jobs:
        state = await qm.get_job(job_id)
        if state.status == DownloadStatus.DOWNLOADING:
            downloading += 1
        elif state.status == DownloadStatus.QUEUED:
            queued += 1
            
    assert downloading == 4  # aria2 limit
    assert queued == 1


@pytest.mark.asyncio
async def test_scheduler_event_driven_wake(qm):
    """Test that a terminal state wakes the scheduler and promotes the next job."""
    # Fill the aria2 slots
    jobs = []
    for _ in range(5):
        job_id = str(uuid4())
        await qm.create_job(job_id, "https://example.com", "aria2")
        jobs.append(job_id)
        
    await asyncio.sleep(0.1)
    
    state_last = await qm.get_job(jobs[4])
    assert state_last.status == DownloadStatus.QUEUED
    
    # Finish the first job
    await qm.update_job(jobs[0], status=DownloadStatus.COMPLETED)
    
    # Wait for scheduler to wake up
    await asyncio.sleep(0.1)
    
    # The 5th job should now be downloading
    state_last = await qm.get_job(jobs[4])
    assert state_last.status == DownloadStatus.DOWNLOADING


@pytest.mark.asyncio
async def test_scheduler_dynamic_limits(qm):
    """Test that updating settings changes the promotion limit dynamically."""
    from src.db import get_db
    
    # Lower aria2 limit to 2
    async with get_db(qm._db_path) as db:
        await db.execute("UPDATE settings SET value = '2' WHERE key = 'engine_limit_aria2'")
        await db.commit()
        
    jobs = []
    for _ in range(4):
        job_id = str(uuid4())
        await qm.create_job(job_id, "https://example.com", "aria2")
        jobs.append(job_id)
        
    await asyncio.sleep(0.1)
    
    downloading = 0
    for job_id in jobs:
        state = await qm.get_job(job_id)
        if state.status == DownloadStatus.DOWNLOADING:
            downloading += 1
            
    assert downloading == 2  # New limit


from src.engines import register_engine

class MockEngine:
    def execute(self, job, request):
        import time
        for i in range(10):
            if getattr(job, '_cancel_flag', False):
                raise InterruptedError("Cancelled")
            job.progress = i * 10
            time.sleep(0.1)
        return {"status": "completed", "output_path": "/tmp/mock.mp4"}

register_engine("aria2", MockEngine())
register_engine("ytdlp", MockEngine())
register_engine("m3u8", MockEngine())


@pytest.mark.asyncio
async def test_pause_and_resume_job(qm):
    """Test DOWNLOADING -> PAUSED -> QUEUED."""
    job_id = str(uuid4())
    await qm.create_job(job_id, "https://example.com", "aria2")
    
    # Wait for it to start downloading
    await asyncio.sleep(0.2)
    state = await qm.get_job(job_id)
    assert state.status == DownloadStatus.DOWNLOADING
    
    # Pause
    await qm.pause_job(job_id)
    state = await qm.get_job(job_id)
    assert state.status == DownloadStatus.PAUSED
    
    # Resume
    await qm.resume_job(job_id)
    state = await qm.get_job(job_id)
    assert state.status == DownloadStatus.QUEUED


@pytest.mark.asyncio
async def test_cancel_job(qm):
    """Test CANCELLED transitions."""
    job_id = str(uuid4())
    await qm.create_job(job_id, "https://example.com", "aria2")
    
    await asyncio.sleep(0.2)
    
    await qm.cancel_job(job_id)
    state = await qm.get_job(job_id)
    assert state.status == DownloadStatus.CANCELLED


@pytest.mark.asyncio
async def test_retry_job(qm):
    """Test FAILED -> QUEUED."""
    job_id = str(uuid4())
    await qm.create_job(job_id, "https://example.com", "aria2")
    await qm.update_job(job_id, status=DownloadStatus.FAILED)
    
    await qm.retry_job(job_id)
    state = await qm.get_job(job_id)
    assert state.status == DownloadStatus.QUEUED


@pytest.mark.asyncio
async def test_invalid_transitions(qm):
    """Verify 409-like errors for invalid transitions."""
    job_id = str(uuid4())
    await qm.create_job(job_id, "https://example.com", "aria2")
    await qm.update_job(job_id, status=DownloadStatus.COMPLETED)
    
    with pytest.raises(ValueError, match="Only DOWNLOADING jobs can be paused"):
        await qm.pause_job(job_id)
        
    with pytest.raises(ValueError, match="Only PAUSED jobs can be resumed"):
        await qm.resume_job(job_id)
        
    with pytest.raises(ValueError, match="Job is already in a terminal state"):
        await qm.cancel_job(job_id)
        
    with pytest.raises(ValueError, match="Only FAILED jobs can be retried"):
        await qm.retry_job(job_id)
