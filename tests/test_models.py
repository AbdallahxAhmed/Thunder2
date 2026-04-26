"""Unit tests for Pydantic model validation."""

from __future__ import annotations

import pytest

from src.models import DownloadRequest, DownloadStatus


class TestDownloadRequest:
    """Validate DownloadRequest field constraints."""

    def test_valid_https_url(self):
        req = DownloadRequest(url="https://example.com/file.zip")
        assert req.url == "https://example.com/file.zip"

    def test_valid_http_url(self):
        req = DownloadRequest(url="http://example.com/file.zip")
        assert req.url == "http://example.com/file.zip"

    def test_valid_ftp_url(self):
        req = DownloadRequest(url="ftp://mirror.example.com/file.iso")
        assert req.url == "ftp://mirror.example.com/file.iso"

    def test_valid_magnet_url(self):
        req = DownloadRequest(url="magnet:?xt=urn:btih:abc123")
        assert req.url.startswith("magnet:")

    def test_invalid_scheme_raises(self):
        with pytest.raises(ValueError):
            DownloadRequest(url="not-a-url")

    def test_empty_url_raises(self):
        with pytest.raises(ValueError):
            DownloadRequest(url="")

    def test_whitespace_url_raises(self):
        with pytest.raises(ValueError):
            DownloadRequest(url="   ")

    def test_valid_drm_keys(self):
        req = DownloadRequest(
            url="https://example.com/stream.mpd",
            drm_keys="abcdef1234567890:fedcba0987654321",
        )
        assert req.drm_keys == "abcdef1234567890:fedcba0987654321"

    def test_invalid_drm_keys_no_colon(self):
        with pytest.raises(ValueError):
            DownloadRequest(
                url="https://example.com/stream.mpd",
                drm_keys="abcdef1234567890",
            )

    def test_invalid_drm_keys_non_hex(self):
        with pytest.raises(ValueError):
            DownloadRequest(
                url="https://example.com/stream.mpd",
                drm_keys="not-hex:also-not-hex",
            )

    def test_optional_fields_default_to_none(self):
        req = DownloadRequest(url="https://example.com/file.zip")
        assert req.cookies is None
        assert req.user_agent is None
        assert req.drm_keys is None


class TestDownloadStatus:
    """Validate DownloadStatus enum values."""

    def test_has_all_states(self):
        states = {s.value for s in DownloadStatus}
        assert states == {"queued", "downloading", "completed", "failed"}

    def test_string_values(self):
        assert DownloadStatus.QUEUED == "queued"
        assert DownloadStatus.DOWNLOADING == "downloading"
        assert DownloadStatus.COMPLETED == "completed"
        assert DownloadStatus.FAILED == "failed"
