"""Tests for the QueueManager Hot Cache and SQLite persistence."""

import asyncio
from datetime import datetime
from uuid import uuid4

import pytest

from src.models import DownloadStatus
from src.queue_manager import QueueManager, ActiveJobState


@pytest.fixture
def qm():
    """Return a fresh QueueManager instance for each test."""
    return QueueManager(db_path=":memory:")


@pytest.mark.asyncio
async def test_create_and_get_job(qm):
    """Test creating a job and retrieving it from Hot Cache."""
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
    """Test updating job progress and status in Hot Cache."""
    job_id = str(uuid4())
    await qm.create_job(job_id, "https://example.com", "ytdlp")
    
    updated = await qm.update_job(job_id, progress=50.5, speed="10 MB/s", status=DownloadStatus.DOWNLOADING)
    
    assert updated.progress == 50.5
    assert updated.speed == "10 MB/s"
    assert updated.status == DownloadStatus.DOWNLOADING

    retrieved = await qm.get_job(job_id)
    assert retrieved.progress == 50.5


@pytest.mark.asyncio
async def test_list_and_delete_jobs(qm):
    """Test listing and deleting jobs in Hot Cache."""
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
