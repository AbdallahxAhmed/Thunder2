"""Unit tests for the aria2 JSON-RPC client."""

from __future__ import annotations

import pytest
from unittest.mock import MagicMock, patch

from src.engines.aria2_client import Aria2Client


@pytest.fixture
def client():
    return Aria2Client(
        rpc_url="http://localhost:6800/jsonrpc",
        rpc_secret="test-secret",
        download_dir="/tmp/test-downloads",
    )


class TestAddDownload:
    """Tests for Aria2Client.add_download()."""

    def test_sends_correct_rpc_payload(self, client: Aria2Client):
        """addUri call must include split=16, max-connection-per-server=16, auth token."""
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"jsonrpc": "2.0", "id": "1", "result": "gid123"}

        with patch("src.engines.aria2_client.requests.post", return_value=mock_resp) as mock_post:
            gid = client.add_download("https://example.com/file.zip")

            mock_post.assert_called_once()
            call_args = mock_post.call_args
            payload = call_args.kwargs.get("json") or call_args[1].get("json")

            assert payload["method"] == "aria2.addUri"
            params = payload["params"]
            assert params[0] == "token:test-secret"
            assert params[1] == ["https://example.com/file.zip"]
            opts = params[2]
            assert opts["split"] == "16"
            assert opts["max-connection-per-server"] == "16"
            assert gid == "gid123"

    def test_passes_user_agent_and_cookies(self, client: Aria2Client):
        """user_agent and cookies must be forwarded to aria2 options."""
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"jsonrpc": "2.0", "id": "1", "result": "gid456"}

        with patch("src.engines.aria2_client.requests.post", return_value=mock_resp) as mock_post:
            client.add_download(
                "https://example.com/file.zip",
                user_agent="TestBot/1.0",
                cookies="session=abc",
            )

            payload = mock_post.call_args.kwargs.get("json") or mock_post.call_args[1]["json"]
            opts = payload["params"][2]
            assert opts["user-agent"] == "TestBot/1.0"
            assert opts["header"] == "Cookie: session=abc"

    def test_connection_error_raises(self, client: Aria2Client):
        """Connection failures must propagate as exceptions."""
        import requests as req

        with patch(
            "src.engines.aria2_client.requests.post",
            side_effect=req.ConnectionError("refused"),
        ):
            with pytest.raises(req.ConnectionError):
                client.add_download("https://example.com/file.zip")


class TestGetStatus:
    """Tests for Aria2Client.get_status()."""

    def test_parses_status_response(self, client: Aria2Client):
        """tellStatus response must be parsed into a dict."""
        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "jsonrpc": "2.0",
            "id": "1",
            "result": {
                "gid": "gid123",
                "status": "active",
                "totalLength": "1000",
                "completedLength": "500",
                "downloadSpeed": "100",
                "files": [{"path": "/tmp/file.zip"}],
            },
        }

        with patch("src.engines.aria2_client.requests.post", return_value=mock_resp):
            status = client.get_status("gid123")

            assert status["status"] == "active"
            assert status["totalLength"] == "1000"
            assert status["completedLength"] == "500"
