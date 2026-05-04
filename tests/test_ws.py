"""WebSocket Event Bus tests.

Validates Phase 8 requirements:
- connect -> snapshot event
- read-only enforcement
- job.progress throttling
- job.state_changed immediate
"""

import asyncio
from datetime import datetime, timezone
import pytest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

from src.main import app
from src.queue_manager import ActiveJobState
from src.models import DownloadStatus

@pytest.fixture
def test_client():
    return TestClient(app)

def _make_fake_job(job_id: str, status: DownloadStatus = DownloadStatus.QUEUED):
    now = datetime.now(timezone.utc)
    return ActiveJobState(
        job_id=job_id,
        url="https://example.com/file.zip",
        engine="aria2",
        status=status,
        created_at=now,
        updated_at=now,
    )

def test_websocket_connect_sends_snapshot(test_client):
    """WebSocket connection should immediately receive a snapshot of all active jobs."""
    fake_job = _make_fake_job("test-job-1")
    
    with patch("src.main.queue_manager.list_jobs", new_callable=AsyncMock) as mock_list:
        mock_list.return_value = [fake_job]
        
        with test_client.websocket_connect("/api/ws/events") as websocket:
            data = websocket.receive_json()
            assert data["type"] == "snapshot"
            assert "jobs" in data["data"]
            assert len(data["data"]["jobs"]) == 1
            assert data["data"]["jobs"][0]["id"] == "test-job-1"

def test_websocket_read_only(test_client):
    """Client messages to the WebSocket should be ignored, and connection stays open."""
    fake_job = _make_fake_job("job-2", DownloadStatus.DOWNLOADING)
    
    with patch("src.main.queue_manager.list_jobs", new_callable=AsyncMock) as mock_list:
        mock_list.return_value = []
        
        with test_client.websocket_connect("/api/ws/events") as websocket:
            websocket.receive_json() # consume snapshot
            
            # Send a client message, it shouldn't crash
            websocket.send_text("Hello")
            websocket.send_json({"foo": "bar"})
            
            # The test passes if it didn't raise WebSocketDisconnect

def test_event_bus_throttling():
    """job.progress events should be throttled (max 2/sec per job)."""
    from src.event_bus import event_bus
    event_bus._job_throttle_state.clear()
    
    with patch.object(event_bus, 'broadcast') as mock_broadcast:
        # Emit two progress updates rapidly
        event_bus.emit_progress("job-3", {"progress": 10.0})
        event_bus.emit_progress("job-3", {"progress": 20.0}) # dropped
        
        # Emit another job's progress
        event_bus.emit_progress("job-4", {"progress": 50.0})
        
        # Verify broadcast calls
        assert mock_broadcast.call_count == 2
        mock_broadcast.assert_any_call("job.progress", {"id": "job-3", "progress": 10.0})
        mock_broadcast.assert_any_call("job.progress", {"id": "job-4", "progress": 50.0})

def test_event_bus_state_changed_immediate():
    """job.state_changed events should not be throttled."""
    from src.event_bus import event_bus
    
    with patch.object(event_bus, 'broadcast') as mock_broadcast:
        event_bus.emit_state_changed("job-5", {"status": "paused"})
        event_bus.emit_state_changed("job-5", {"status": "queued"})
        
        assert mock_broadcast.call_count == 2


