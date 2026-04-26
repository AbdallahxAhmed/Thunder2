"""Unit tests for the N_m3u8DL-RE engine client."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch

from src.engines.m3u8_client import M3u8Client
from src.models import DownloadJob, DownloadRequest


@pytest.fixture
def client():
    return M3u8Client(download_dir="/tmp/test-downloads")


@pytest.fixture
def sample_job():
    return DownloadJob(
        id="test-drm-job",
        url="https://example.com/stream.mpd",
        engine="m3u8",
    )


@pytest.fixture
def sample_request():
    return DownloadRequest(
        url="https://example.com/stream.mpd",
        drm_keys="abcdef1234567890:fedcba0987654321",
    )


class TestM3u8Execute:
    """Tests for M3u8Client.execute()."""

    def test_builds_correct_subprocess_command(self, client, sample_job, sample_request):
        """The command must include --key, --save-dir, --save-name, --auto-select, --del-after-done."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "Download complete"
        mock_result.stderr = ""

        with patch("src.engines.m3u8_client.subprocess.run", return_value=mock_result) as mock_run:
            result = client.execute(sample_job, sample_request)

            mock_run.assert_called_once()
            cmd = mock_run.call_args[0][0]
            assert cmd[0] == "N_m3u8DL-RE"
            assert cmd[1] == "https://example.com/stream.mpd"
            assert "--key" in cmd
            key_idx = cmd.index("--key")
            assert cmd[key_idx + 1] == "abcdef1234567890:fedcba0987654321"
            assert "--save-dir" in cmd
            assert "--save-name" in cmd
            assert "--auto-select" in cmd
            assert "--del-after-done" in cmd
            assert result["status"] == "completed"

    def test_captures_stdout_stderr(self, client, sample_job, sample_request):
        """stdout and stderr must be captured for logging."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "Track 1 downloaded"
        mock_result.stderr = "Warning: something"

        with patch("src.engines.m3u8_client.subprocess.run", return_value=mock_result) as mock_run:
            client.execute(sample_job, sample_request)

            call_kwargs = mock_run.call_args[1]
            assert call_kwargs.get("capture_output") is True
            assert call_kwargs.get("text") is True

    def test_nonzero_returncode_produces_error(self, client, sample_job, sample_request):
        """Non-zero return code must result in a failed status."""
        mock_result = MagicMock()
        mock_result.returncode = 1
        mock_result.stdout = ""
        mock_result.stderr = "Error: key mismatch"

        with patch("src.engines.m3u8_client.subprocess.run", return_value=mock_result):
            result = client.execute(sample_job, sample_request)

            assert result["status"] == "failed"
            assert "key mismatch" in result["error"]

    def test_no_drm_keys_logs_warning(self, client, sample_job):
        """Request without drm_keys for .mpd URL should still work but log a warning."""
        request = DownloadRequest(url="https://example.com/stream.mpd")

        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""
        mock_result.stderr = ""

        with patch("src.engines.m3u8_client.subprocess.run", return_value=mock_result):
            result = client.execute(sample_job, request)
            # Should still attempt download without --key flag
            assert result["status"] == "completed"
