"""Shared test fixtures and mocks for UHDD tests."""

from __future__ import annotations

import asyncio
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import pytest_asyncio

# Override settings BEFORE importing anything from src
# so config.settings picks up test values
import os

os.environ.setdefault("ARIA2_RPC_URL", "http://localhost:6800/jsonrpc")
os.environ.setdefault("ARIA2_RPC_SECRET", "test-secret")
os.environ.setdefault("DOWNLOAD_DIR", "/tmp/uhdd-test-downloads")
os.environ.setdefault("LOG_DIR", "/tmp/uhdd-test-logs")
os.environ.setdefault("LOG_LEVEL", "DEBUG")


@pytest.fixture(scope="session")
def event_loop():
    """Create a session-scoped event loop for pytest-asyncio."""
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture
async def async_client():
    """Provide an httpx AsyncClient wired to the FastAPI test app."""
    from httpx import ASGITransport, AsyncClient
    from src.main import app

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


@pytest.fixture
def mock_aria2_success():
    """Mock requests.post to simulate a successful aria2 addUri response."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "jsonrpc": "2.0",
        "id": "dark-downloader",
        "result": "abc123def456",
    }
    mock_response.raise_for_status = MagicMock()
    with patch("src.engines.aria2_client.requests.post", return_value=mock_response) as m:
        yield m


@pytest.fixture
def mock_aria2_status():
    """Mock aria2 tellStatus response."""
    mock_response = MagicMock()
    mock_response.json.return_value = {
        "jsonrpc": "2.0",
        "id": "dark-downloader",
        "result": {
            "gid": "abc123def456",
            "status": "complete",
            "totalLength": "104857600",
            "completedLength": "104857600",
            "downloadSpeed": "0",
            "files": [{"path": "/tmp/uhdd-test-downloads/file.zip"}],
        },
    }
    with patch("src.engines.aria2_client.requests.post", return_value=mock_response) as m:
        yield m


@pytest.fixture
def mock_aria2_connection_error():
    """Mock aria2 RPC connection failure."""
    import requests as req

    with patch(
        "src.engines.aria2_client.requests.post",
        side_effect=req.ConnectionError("Connection refused"),
    ) as m:
        yield m


@pytest.fixture
def mock_all_engines_available():
    """Mock all engine health checks as available."""
    from src.models import EngineHealth

    engines = [
        EngineHealth(name="aria2", available=True, version="1.37.0"),
        EngineHealth(name="ytdlp", available=True, version="2025.12.01"),
        EngineHealth(name="m3u8", available=True, version=None),
    ]
    with patch("src.main.check_all_engines", return_value=engines):
        yield engines


@pytest.fixture
def mock_aria2_unavailable():
    """Mock aria2 health check as unavailable."""
    from src.models import EngineHealth

    engines = [
        EngineHealth(
            name="aria2", available=False, error="aria2 RPC unreachable"
        ),
        EngineHealth(name="ytdlp", available=True, version="2025.12.01"),
        EngineHealth(name="m3u8", available=True, version=None),
    ]
    with patch("src.main.check_all_engines", return_value=engines):
        with patch("src.main._engine_health", engines):
            yield engines
