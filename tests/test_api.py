"""API integration tests for Thunder endpoints.

Mocking strategy: We mock ``queue_manager.create_job`` and
``queue_manager.get_job`` on ``src.main`` so that no real SQLite database
or scheduler loop is started during these tests.  The mocks return
lightweight ``ActiveJobState`` dataclass instances that satisfy the
endpoint serialization contract.
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
