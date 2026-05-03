"""API integration tests for UHDD endpoints."""

from __future__ import annotations

import pytest
from unittest.mock import patch, MagicMock, AsyncMock

pytestmark = pytest.mark.asyncio


class TestPostDownload:
    """Tests for POST /api/download."""

    async def test_standard_url_returns_202(self, async_client, mock_all_engines_available):
        """A standard file URL should be accepted and routed to aria2."""
        with patch("src.main._execute_download", new_callable=AsyncMock):
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
        with patch("src.main._execute_download", new_callable=AsyncMock):
            resp = await async_client.post(
                "/api/download",
                json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            )

        assert resp.status_code == 202
        assert resp.json()["engine"] == "ytdlp"

    async def test_drm_keys_routes_to_m3u8(self, async_client, mock_all_engines_available):
        """A request with drm_keys should be routed to m3u8 engine."""
        with patch("src.main._execute_download", new_callable=AsyncMock):
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
        with patch("src.main._execute_download", new_callable=AsyncMock):
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
        with patch("src.main._execute_download", new_callable=AsyncMock):
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


class TestGetDownloadStatus:
    """Tests for GET /api/download/{id}."""

    async def test_existing_job_returns_200(self, async_client, mock_all_engines_available):
        """Querying an existing job ID should return its status."""
        with patch("src.main._execute_download", new_callable=AsyncMock):
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
        resp = await async_client.get("/api/download/nonexistent-id")
        assert resp.status_code == 404
        assert resp.json()["error_code"] == "JOB_NOT_FOUND"


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
