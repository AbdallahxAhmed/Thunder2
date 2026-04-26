"""Unit tests for the in-memory job manager."""

from __future__ import annotations

import pytest

from src.job_manager import JobManager
from src.models import DownloadStatus

pytestmark = pytest.mark.asyncio


@pytest.fixture
async def manager():
    """Fresh job manager for each test."""
    return JobManager()


class TestCreateJob:
    """Tests for JobManager.create_job()."""

    async def test_returns_job_with_queued_status(self, manager: JobManager):
        job = await manager.create_job("https://example.com/file.zip", "aria2")
        assert job.status == DownloadStatus.QUEUED

    async def test_returns_valid_uuid(self, manager: JobManager):
        import uuid

        job = await manager.create_job("https://example.com/file.zip", "aria2")
        parsed = uuid.UUID(job.id)
        assert str(parsed) == job.id

    async def test_stores_url_and_engine(self, manager: JobManager):
        job = await manager.create_job("https://example.com/file.zip", "aria2")
        assert job.url == "https://example.com/file.zip"
        assert job.engine == "aria2"


class TestGetJob:
    """Tests for JobManager.get_job()."""

    async def test_returns_correct_job(self, manager: JobManager):
        created = await manager.create_job("https://example.com/a.zip", "aria2")
        fetched = await manager.get_job(created.id)
        assert fetched is not None
        assert fetched.id == created.id
        assert fetched.url == created.url

    async def test_returns_none_for_invalid_id(self, manager: JobManager):
        result = await manager.get_job("nonexistent-id")
        assert result is None


class TestUpdateJob:
    """Tests for JobManager.update_job()."""

    async def test_transitions_status(self, manager: JobManager):
        job = await manager.create_job("https://example.com/file.zip", "aria2")
        updated = await manager.update_job(job.id, status=DownloadStatus.DOWNLOADING)
        assert updated is not None
        assert updated.status == DownloadStatus.DOWNLOADING

    async def test_updates_progress(self, manager: JobManager):
        job = await manager.create_job("https://example.com/file.zip", "aria2")
        await manager.update_job(job.id, progress=45.5, speed="10.0 MB/s")
        fetched = await manager.get_job(job.id)
        assert fetched.progress == 45.5
        assert fetched.speed == "10.0 MB/s"

    async def test_updates_timestamp(self, manager: JobManager):
        job = await manager.create_job("https://example.com/file.zip", "aria2")
        original_updated = job.updated_at
        import asyncio
        await asyncio.sleep(0.01)
        await manager.update_job(job.id, status=DownloadStatus.COMPLETED)
        fetched = await manager.get_job(job.id)
        assert fetched.updated_at > original_updated

    async def test_returns_none_for_unknown_id(self, manager: JobManager):
        result = await manager.update_job("nonexistent", status=DownloadStatus.FAILED)
        assert result is None


class TestListJobs:
    """Tests for JobManager.list_jobs()."""

    async def test_returns_all_jobs(self, manager: JobManager):
        await manager.create_job("https://example.com/a.zip", "aria2")
        await manager.create_job("https://youtube.com/watch?v=x", "ytdlp")
        jobs = await manager.list_jobs()
        assert len(jobs) == 2
