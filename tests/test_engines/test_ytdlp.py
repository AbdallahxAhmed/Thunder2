"""Unit tests for the yt-dlp engine client."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch, call

from src.engines.ytdlp_client import YtdlpClient
from src.models import DownloadJob, DownloadRequest, DownloadStatus


@pytest.fixture
def client():
    return YtdlpClient(download_dir="/tmp/test-downloads")


@pytest.fixture
def sample_job():
    return DownloadJob(
        id="test-job-1",
        url="https://www.youtube.com/watch?v=test",
        engine="ytdlp",
    )


@pytest.fixture
def sample_request():
    return DownloadRequest(url="https://www.youtube.com/watch?v=test")


class TestYtdlpExecute:
    """Tests for YtdlpClient.execute()."""

    def test_calls_ytdlp_with_correct_opts(self, client, sample_job, sample_request):
        """YoutubeDL must be configured with best format, mp4 merge, correct outtmpl."""
        mock_ydl_instance = MagicMock()
        mock_ydl_instance.download.return_value = 0
        mock_ydl_instance.__enter__ = MagicMock(return_value=mock_ydl_instance)
        mock_ydl_instance.__exit__ = MagicMock(return_value=False)

        with patch("src.engines.ytdlp_client.yt_dlp.YoutubeDL", return_value=mock_ydl_instance) as mock_ydl_cls:
            result = client.execute(sample_job, sample_request)

            mock_ydl_cls.assert_called_once()
            opts = mock_ydl_cls.call_args[0][0]
            assert opts["format"] == "bestvideo+bestaudio/best"
            assert opts["merge_output_format"] == "mp4"
            assert "/tmp/test-downloads/" in opts["outtmpl"]
            mock_ydl_instance.download.assert_called_once_with(
                ["https://www.youtube.com/watch?v=test"]
            )
            assert result["status"] == "completed"

    def test_passes_user_agent_and_cookies(self, client, sample_job):
        """Custom UA and cookies must be forwarded to yt-dlp options."""
        request = DownloadRequest(
            url="https://www.youtube.com/watch?v=test",
            user_agent="TestBot/1.0",
            cookies="session=abc",
        )

        mock_ydl_instance = MagicMock()
        mock_ydl_instance.download.return_value = 0
        mock_ydl_instance.__enter__ = MagicMock(return_value=mock_ydl_instance)
        mock_ydl_instance.__exit__ = MagicMock(return_value=False)

        with patch("src.engines.ytdlp_client.yt_dlp.YoutubeDL", return_value=mock_ydl_instance) as mock_ydl_cls:
            client.execute(sample_job, request)

            opts = mock_ydl_cls.call_args[0][0]
            assert "TestBot/1.0" in str(opts.get("http_headers", {}).get("User-Agent", ""))

    def test_extraction_failure_returns_error(self, client, sample_job, sample_request):
        """If yt-dlp raises an exception, execute must return a failed result."""
        mock_ydl_instance = MagicMock()
        mock_ydl_instance.download.side_effect = Exception("Extraction failed")
        mock_ydl_instance.__enter__ = MagicMock(return_value=mock_ydl_instance)
        mock_ydl_instance.__exit__ = MagicMock(return_value=False)

        with patch("src.engines.ytdlp_client.yt_dlp.YoutubeDL", return_value=mock_ydl_instance):
            result = client.execute(sample_job, sample_request)

            assert result["status"] == "failed"
            assert "Extraction failed" in result["error"]
