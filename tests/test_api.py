"""API integration tests for Thunder endpoints.

Mocking strategy: We mock ``queue_manager`` methods on ``src.main`` so that
no real SQLite database or scheduler loop is started during these tests.
The mocks return lightweight ``ActiveJobState`` dataclass instances that
satisfy the endpoint serialization contract.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest

from src.models import DownloadStatus
from src.queue_manager import ActiveJobState

pytestmark = pytest.mark.asyncio


# ── Helpers ───────────────────────────────────────────────────────────────


def _make_fake_job(engine: str = "aria2", **overrides) -> ActiveJobState:
    """Build a lightweight ActiveJobState for assertions."""
    now = datetime.now(timezone.utc)
    defaults = dict(
        job_id=str(uuid4()),
        url="https://example.com/file.zip",
        engine=engine,
        status=DownloadStatus.QUEUED,
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return ActiveJobState(**defaults)


# ── POST /api/download ────────────────────────────────────────────────────


class TestPostDownload:
    """Tests for POST /api/download."""

    async def test_standard_url_returns_202(self, async_client, mock_all_engines_available):
        """A standard file URL should be accepted and routed to aria2."""
        fake = _make_fake_job("aria2")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_job = AsyncMock(return_value=fake)
            resp = await async_client.post(
                "/api/download",
                json={"url": "https://example.com/file.zip"},
            )

        assert resp.status_code == 202
        body = resp.json()
        assert "id" in body
        assert body["status"] == "queued"
        assert body["engine"] == "aria2"

    async def test_missing_url_returns_422(self, async_client):
        """A request without a URL must fail validation."""
        resp = await async_client.post("/api/download", json={})
        assert resp.status_code == 422

    async def test_invalid_url_scheme_returns_422(self, async_client):
        """A URL without a valid scheme must fail validation."""
        resp = await async_client.post(
            "/api/download", json={"url": "not-a-url"}
        )
        assert resp.status_code == 422

    async def test_youtube_url_routes_to_ytdlp(self, async_client, mock_all_engines_available):
        """A YouTube URL should be routed to the ytdlp engine."""
        fake = _make_fake_job("ytdlp")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_job = AsyncMock(return_value=fake)
            resp = await async_client.post(
                "/api/download",
                json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            )

        assert resp.status_code == 202
        assert resp.json()["engine"] == "ytdlp"

    async def test_drm_keys_routes_to_m3u8(self, async_client, mock_all_engines_available):
        """A request with drm_keys should be routed to m3u8 engine."""
        fake = _make_fake_job("m3u8")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_job = AsyncMock(return_value=fake)
            resp = await async_client.post(
                "/api/download",
                json={
                    "url": "https://example.com/stream.mpd",
                    "drm_keys": "abcdef1234:fedcba5678",
                },
            )

        assert resp.status_code == 202
        assert resp.json()["engine"] == "m3u8"

    async def test_pssh_license_routes_to_m3u8(self, async_client, mock_all_engines_available):
        """A request with pssh + license_url should be routed to m3u8 engine."""
        fake = _make_fake_job("m3u8")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_job = AsyncMock(return_value=fake)
            resp = await async_client.post(
                "/api/download",
                json={
                    "url": "https://cdn.example.com/stream.mpd",
                    "pssh": "base64pssh",
                    "license_url": "https://license.example.com",
                    "license_headers": {"authorization": "Bearer token"},
                },
            )

        assert resp.status_code == 202
        assert resp.json()["engine"] == "m3u8"

    async def test_drm_hint_routes_to_m3u8(self, async_client, mock_all_engines_available):
        """A request with drm_hint should be routed to m3u8 engine."""
        fake = _make_fake_job("m3u8")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_job = AsyncMock(return_value=fake)
            resp = await async_client.post(
                "/api/download",
                json={
                    "url": "https://cdn.example.com/stream.m3u8",
                    "drm_hint": True,
                },
            )

        assert resp.status_code == 202
        assert resp.json()["engine"] == "m3u8"

    async def test_invalid_drm_keys_returns_422(self, async_client):
        """Invalid drm_keys format must fail validation."""
        resp = await async_client.post(
            "/api/download",
            json={"url": "https://example.com/stream.mpd", "drm_keys": "not-valid"},
        )
        assert resp.status_code == 422


# ── GET /api/download/{id} ────────────────────────────────────────────────


class TestGetDownloadStatus:
    """Tests for GET /api/download/{id}."""

    async def test_existing_job_returns_200(self, async_client, mock_all_engines_available):
        """Querying an existing job ID should return its status."""
        fake = _make_fake_job("aria2")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_job = AsyncMock(return_value=fake)
            mock_qm.get_job = AsyncMock(return_value=fake)
            post_resp = await async_client.post(
                "/api/download",
                json={"url": "https://example.com/file.zip"},
            )
            job_id = post_resp.json()["id"]

            resp = await async_client.get(f"/api/download/{job_id}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["id"] == job_id
        assert body["status"] in ("queued", "downloading", "completed", "failed")

    async def test_unknown_id_returns_404(self, async_client):
        """Querying an unknown job ID should return 404."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.get_job = AsyncMock(return_value=None)
            resp = await async_client.get("/api/download/nonexistent-id")

        assert resp.status_code == 404
        assert resp.json()["error_code"] == "JOB_NOT_FOUND"


# ── GET /api/health ───────────────────────────────────────────────────────


class TestHealthEndpoint:
    """Tests for GET /api/health."""

    async def test_health_returns_engine_list(self, async_client, mock_all_engines_available):
        """Health endpoint should return engine availability."""
        resp = await async_client.get("/api/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "healthy"
        assert len(body["engines"]) == 3
        engine_names = {e["name"] for e in body["engines"]}
        assert engine_names == {"aria2", "ytdlp", "m3u8"}


# ── GET /api/jobs (Phase 7) ──────────────────────────────────────────────


class TestListJobs:
    """Tests for GET /api/jobs — paginated, filterable job list."""

    async def test_list_jobs_returns_paginated(self, async_client):
        """GET /api/jobs returns paginated job list."""
        fake_jobs = [_make_fake_job("aria2"), _make_fake_job("ytdlp")]
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.list_jobs = AsyncMock(return_value=fake_jobs)
            mock_qm.count_jobs = AsyncMock(return_value=2)
            resp = await async_client.get("/api/jobs")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 2
        assert body["limit"] == 50
        assert body["offset"] == 0
        assert len(body["jobs"]) == 2

    async def test_list_jobs_with_filters(self, async_client):
        """GET /api/jobs respects status and engine filters."""
        fake = _make_fake_job("aria2", status=DownloadStatus.DOWNLOADING)
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.list_jobs = AsyncMock(return_value=[fake])
            mock_qm.count_jobs = AsyncMock(return_value=1)
            resp = await async_client.get("/api/jobs?status=downloading&engine=aria2")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["jobs"][0]["status"] == "downloading"
        assert body["jobs"][0]["engine"] == "aria2"

    async def test_list_jobs_empty(self, async_client):
        """GET /api/jobs returns empty list when no jobs."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.list_jobs = AsyncMock(return_value=[])
            mock_qm.count_jobs = AsyncMock(return_value=0)
            resp = await async_client.get("/api/jobs")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 0
        assert body["jobs"] == []

    async def test_list_jobs_pagination(self, async_client):
        """GET /api/jobs respects limit and offset parameters."""
        fake = _make_fake_job("aria2")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.list_jobs = AsyncMock(return_value=[fake])
            mock_qm.count_jobs = AsyncMock(return_value=10)
            resp = await async_client.get("/api/jobs?limit=1&offset=5")

        assert resp.status_code == 200
        body = resp.json()
        assert body["limit"] == 1
        assert body["offset"] == 5
        assert body["total"] == 10


# ── Job Actions (Phase 7) ────────────────────────────────────────────────


class TestJobActions:
    """Tests for POST /api/jobs/{id}/pause|resume|cancel|retry and DELETE."""

    async def test_pause_job_success(self, async_client):
        """POST /api/jobs/{id}/pause returns 200 on success."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.pause_job = AsyncMock(return_value=None)
            resp = await async_client.post("/api/jobs/test-id/pause")

        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "pause"
        assert body["status"] == "paused"

    async def test_pause_job_invalid_state(self, async_client):
        """POST /api/jobs/{id}/pause returns 409 on invalid state."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.pause_job = AsyncMock(side_effect=ValueError("Only DOWNLOADING jobs can be paused."))
            resp = await async_client.post("/api/jobs/test-id/pause")

        assert resp.status_code == 409
        assert resp.json()["error_code"] == "INVALID_STATE_TRANSITION"

    async def test_resume_job_success(self, async_client):
        """POST /api/jobs/{id}/resume returns 200 on success."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.resume_job = AsyncMock(return_value=None)
            resp = await async_client.post("/api/jobs/test-id/resume")

        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "resume"
        assert body["status"] == "queued"

    async def test_resume_job_invalid_state(self, async_client):
        """POST /api/jobs/{id}/resume returns 409 on invalid state."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.resume_job = AsyncMock(side_effect=ValueError("Only PAUSED jobs can be resumed."))
            resp = await async_client.post("/api/jobs/test-id/resume")

        assert resp.status_code == 409

    async def test_cancel_job_success(self, async_client):
        """POST /api/jobs/{id}/cancel returns 200 on success."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.cancel_job = AsyncMock(return_value=None)
            resp = await async_client.post("/api/jobs/test-id/cancel")

        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "cancel"
        assert body["status"] == "cancelled"

    async def test_cancel_job_invalid_state(self, async_client):
        """POST /api/jobs/{id}/cancel returns 409 on terminal state."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.cancel_job = AsyncMock(side_effect=ValueError("Job is already in a terminal state."))
            resp = await async_client.post("/api/jobs/test-id/cancel")

        assert resp.status_code == 409

    async def test_retry_job_success(self, async_client):
        """POST /api/jobs/{id}/retry returns 200 on success."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.retry_job = AsyncMock(return_value=None)
            resp = await async_client.post("/api/jobs/test-id/retry")

        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "retry"
        assert body["status"] == "queued"

    async def test_retry_job_invalid_state(self, async_client):
        """POST /api/jobs/{id}/retry returns 409 on non-FAILED state."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.retry_job = AsyncMock(side_effect=ValueError("Only FAILED jobs can be retried."))
            resp = await async_client.post("/api/jobs/test-id/retry")

        assert resp.status_code == 409

    async def test_delete_job_success(self, async_client):
        """DELETE /api/jobs/{id} returns 200 on success."""
        fake = _make_fake_job("aria2")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.get_job = AsyncMock(return_value=fake)
            mock_qm.delete_job = AsyncMock(return_value=None)
            resp = await async_client.delete(f"/api/jobs/{fake.job_id}")

        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "delete"
        assert body["status"] == "deleted"

    async def test_delete_job_not_found(self, async_client):
        """DELETE /api/jobs/{id} returns 404 for unknown ID."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.get_job = AsyncMock(return_value=None)
            resp = await async_client.delete("/api/jobs/nonexistent-id")

        assert resp.status_code == 404
        assert resp.json()["error_code"] == "JOB_NOT_FOUND"


# ── Groups (Phase 7) ─────────────────────────────────────────────────────


class TestGroups:
    """Tests for group CRUD endpoints."""

    async def test_create_group_no_urls(self, async_client):
        """POST /api/groups creates a group without child jobs."""
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_group = AsyncMock(return_value={
                "id": "g1", "name": "Test Group", "source_url": None,
                "status": "active", "created_at": now, "updated_at": now,
            })
            mock_qm.get_group = AsyncMock(return_value={
                "id": "g1", "name": "Test Group", "source_url": None,
                "status": "active", "created_at": now, "updated_at": now,
                "jobs": [],
            })
            resp = await async_client.post(
                "/api/groups", json={"name": "Test Group"}
            )

        assert resp.status_code == 201
        body = resp.json()
        assert body["name"] == "Test Group"
        assert body["status"] == "active"
        assert body["jobs"] == []

    async def test_create_group_with_urls(self, async_client):
        """POST /api/groups creates a group with child jobs."""
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.create_group = AsyncMock(return_value={
                "id": "g2", "name": "Playlist", "source_url": "https://example.com",
                "status": "active", "created_at": now, "updated_at": now,
            })
            mock_qm.create_job = AsyncMock(return_value=_make_fake_job("aria2"))
            mock_qm.get_group = AsyncMock(return_value={
                "id": "g2", "name": "Playlist", "source_url": "https://example.com",
                "status": "active", "created_at": now, "updated_at": now,
                "jobs": [
                    {"id": "j1", "url": "https://example.com/a.zip", "engine": "aria2",
                     "status": "queued", "progress": None, "speed": None, "eta": None,
                     "output_path": None, "file_size": None, "error": None,
                     "group_id": "g2", "title": None, "created_at": now, "updated_at": now},
                ],
            })
            resp = await async_client.post(
                "/api/groups",
                json={"name": "Playlist", "source_url": "https://example.com",
                      "urls": ["https://example.com/a.zip"]},
            )

        assert resp.status_code == 201
        body = resp.json()
        assert len(body["jobs"]) == 1
        mock_qm.create_job.assert_called_once()

    async def test_list_groups(self, async_client):
        """GET /api/groups returns group list with counts."""
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.list_groups = AsyncMock(return_value=[
                {"id": "g1", "name": "Group 1", "source_url": None, "status": "active",
                 "total_jobs": 5, "completed_jobs": 2, "failed_jobs": 1,
                 "created_at": now, "updated_at": now},
            ])
            resp = await async_client.get("/api/groups")

        assert resp.status_code == 200
        body = resp.json()
        assert body["total"] == 1
        assert body["groups"][0]["total_jobs"] == 5

    async def test_get_group_found(self, async_client):
        """GET /api/groups/{id} returns group detail."""
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.get_group = AsyncMock(return_value={
                "id": "g1", "name": "Group 1", "source_url": None,
                "status": "active", "created_at": now, "updated_at": now,
                "jobs": [],
            })
            resp = await async_client.get("/api/groups/g1")

        assert resp.status_code == 200
        assert resp.json()["id"] == "g1"

    async def test_get_group_not_found(self, async_client):
        """GET /api/groups/{id} returns 404 for unknown group."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.get_group = AsyncMock(return_value=None)
            resp = await async_client.get("/api/groups/nonexistent")

        assert resp.status_code == 404
        assert resp.json()["error_code"] == "GROUP_NOT_FOUND"

    async def test_pause_group(self, async_client):
        """POST /api/groups/{id}/pause returns count of paused jobs."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.pause_group = AsyncMock(return_value=3)
            resp = await async_client.post("/api/groups/g1/pause")

        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "pause_group"
        assert "3" in body["message"]

    async def test_resume_group(self, async_client):
        """POST /api/groups/{id}/resume returns count of resumed jobs."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.resume_group = AsyncMock(return_value=2)
            resp = await async_client.post("/api/groups/g1/resume")

        assert resp.status_code == 200
        body = resp.json()
        assert body["action"] == "resume_group"

    async def test_delete_group_success(self, async_client):
        """DELETE /api/groups/{id} returns 200 on success."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.delete_group = AsyncMock(return_value=True)
            resp = await async_client.delete("/api/groups/g1")

        assert resp.status_code == 200
        assert resp.json()["action"] == "delete_group"

    async def test_delete_group_not_found(self, async_client):
        """DELETE /api/groups/{id} returns 404 for unknown group."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.delete_group = AsyncMock(return_value=False)
            resp = await async_client.delete("/api/groups/nonexistent")

        assert resp.status_code == 404


# ── Settings (Phase 7) ───────────────────────────────────────────────────


class TestSettings:
    """Tests for settings endpoints."""

    async def test_get_settings(self, async_client):
        """GET /api/settings returns key-value pairs."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.get_settings = AsyncMock(return_value={
                "global_max_concurrent": "8",
                "engine_limit_aria2": "4",
            })
            resp = await async_client.get("/api/settings")

        assert resp.status_code == 200
        body = resp.json()
        assert body["settings"]["global_max_concurrent"] == "8"

    async def test_update_settings_success(self, async_client):
        """PUT /api/settings updates and returns new settings."""
        with patch("src.main.queue_manager") as mock_qm:
            mock_qm.update_settings = AsyncMock(return_value={
                "global_max_concurrent": "10",
                "engine_limit_aria2": "4",
            })
            resp = await async_client.put(
                "/api/settings",
                json={"settings": {"global_max_concurrent": "10"}},
            )

        assert resp.status_code == 200
        body = resp.json()
        assert body["settings"]["global_max_concurrent"] == "10"

    async def test_update_settings_invalid_limit(self, async_client):
        """PUT /api/settings rejects limit < 1."""
        resp = await async_client.put(
            "/api/settings",
            json={"settings": {"engine_limit_aria2": "0"}},
        )
        assert resp.status_code == 422
        assert resp.json()["error_code"] == "VALIDATION_ERROR"

    async def test_update_settings_non_integer_limit(self, async_client):
        """PUT /api/settings rejects non-integer limit."""
        resp = await async_client.put(
            "/api/settings",
            json={"settings": {"global_max_concurrent": "abc"}},
        )
        assert resp.status_code == 422
        assert resp.json()["error_code"] == "VALIDATION_ERROR"
