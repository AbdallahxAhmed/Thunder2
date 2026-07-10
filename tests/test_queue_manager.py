"""Unit tests for the SQLite-backed Queue Manager."""

from __future__ import annotations

import os
import uuid
import pytest
import pytest_asyncio

from src.queue_manager import QueueManager
from src.models import DownloadStatus

pytestmark = pytest.mark.asyncio


@pytest_asyncio.fixture
async def manager():
    """Fresh QueueManager using an in-memory SQLite database for test isolation."""
    # Using an unique path name or :memory: for SQLite
    # Note: SQLite :memory: requires check_same_thread=False
    qm = QueueManager(db_path=":memory:")
    await qm.start()
    yield qm
    await qm.shutdown()


class TestCreateJob:
    """Tests for QueueManager.create_job()."""

    async def test_returns_job_with_queued_status(self, manager: QueueManager):
        job_id = str(uuid.uuid4())
        state = await manager.create_job(
            job_id=job_id, url="https://example.com/file.mp4", engine="m3u8"
        )
        assert state.status == DownloadStatus.QUEUED
        assert state.job_id == job_id

    async def test_stores_url_and_engine(self, manager: QueueManager):
        job_id = str(uuid.uuid4())
        state = await manager.create_job(
            job_id=job_id, url="https://example.com/file.mp4", engine="m3u8"
        )
        assert state.url == "https://example.com/file.mp4"
        assert state.engine == "m3u8"


class TestGetJob:
    """Tests for QueueManager.get_job()."""

    async def test_returns_correct_job(self, manager: QueueManager):
        job_id = str(uuid.uuid4())
        created = await manager.create_job(
            job_id=job_id, url="https://example.com/file.mp4", engine="m3u8"
        )
        fetched = await manager.get_job(job_id)
        assert fetched is not None
        assert fetched.job_id == created.job_id
        assert fetched.url == created.url

    async def test_returns_none_for_invalid_id(self, manager: QueueManager):
        result = await manager.get_job("nonexistent-id")
        assert result is None


class TestUpdateJob:
    """Tests for QueueManager.update_job()."""

    async def test_transitions_status(self, manager: QueueManager):
        job_id = str(uuid.uuid4())
        await manager.create_job(
            job_id=job_id, url="https://example.com/file.mp4", engine="m3u8"
        )
        updated = await manager.update_job(job_id, status=DownloadStatus.DOWNLOADING)
        assert updated is not None
        assert updated.status == DownloadStatus.DOWNLOADING

    async def test_updates_progress_in_cache(self, manager: QueueManager):
        job_id = str(uuid.uuid4())
        await manager.create_job(
            job_id=job_id, url="https://example.com/file.mp4", engine="m3u8"
        )
        await manager.update_job(job_id, progress=45.5, speed="10.0 MB/s")
        fetched = await manager.get_job(job_id)
        assert fetched.progress == 45.5
        assert fetched.speed == "10.0 MB/s"


class TestListJobs:
    """Tests for QueueManager.list_jobs()."""

    async def test_returns_all_jobs(self, manager: QueueManager):
        id1 = str(uuid.uuid4())
        id2 = str(uuid.uuid4())
        await manager.create_job(id1, "https://example.com/a.mp4", "m3u8")
        await manager.create_job(id2, "https://youtube.com/watch?v=x", "ytdlp")
        
        jobs = await manager.list_jobs(limit=10)
        assert len(jobs) == 2
