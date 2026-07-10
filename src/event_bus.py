"""WebSocket Event Bus for pushing real-time state to GUI clients.

Provides non-blocking, throttled event broadcasting.
"""

from __future__ import annotations

import asyncio
import time
import logging
from typing import Any
from fastapi import WebSocket

logger = logging.getLogger(__name__)

class EventBus:
    """Singleton event bus for real-time WebSocket updates."""

    def __init__(self):
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._job_throttle_state: dict[str, float] = {}
        self._group_throttle_state: dict[str, float] = {}

    async def connect(self, websocket: WebSocket):
        """Add a client and send initial snapshot."""
        async with self._lock:
            self._clients.add(websocket)
            
        # Send snapshot (QueueManager will provide this)
        from src.queue_manager import queue_manager
        from src.models import DownloadStatus
        
        jobs = await queue_manager.list_jobs(limit=1000)
        snapshot_data = []
        for j in jobs:
            snapshot_data.append({
                "id": j.job_id,
                "url": j.url,
                "engine": j.engine,
                "status": j.status.value if isinstance(j.status, DownloadStatus) else j.status,
                "progress": j.progress,
                "speed": j.speed,
                "eta": j.eta,
                "output_path": j.output_path,
                "file_size": j.file_size,
                "error": j.error,
                "group_id": j.group_id,
                "title": j.title,
                "created_at": j.created_at.isoformat(),
                "updated_at": j.updated_at.isoformat(),
            })
            
        await self._send_to_client(websocket, {"type": "snapshot", "data": {"jobs": snapshot_data}})

    async def disconnect(self, websocket: WebSocket):
        """Remove a client."""
        async with self._lock:
            self._clients.discard(websocket)

    async def _send_to_client(self, ws: WebSocket, event_data: dict[str, Any]):
        """Send a single message to a client, handling disconnection."""
        try:
            await ws.send_json(event_data)
        except Exception:
            await self.disconnect(ws)

    async def _broadcast_internal(self, event_data: dict[str, Any]):
        """Internal broadcast logic (runs in a background task)."""
        async with self._lock:
            clients = list(self._clients)
            
        if not clients:
            return
            
        await asyncio.gather(
            *[self._send_to_client(ws, event_data) for ws in clients],
            return_exceptions=True
        )

    def broadcast(self, event_type: str, payload: dict[str, Any]):
        """Fire-and-forget broadcast to all connected clients."""
        event_data = {"type": event_type, "data": payload}
        try:
            asyncio.create_task(self._broadcast_internal(event_data))
        except RuntimeError:
            # No running event loop (e.g. during tests or shutdown)
            pass

    def emit_state_changed(self, job_id: str, payload: dict[str, Any]):
        """Emit unthrottled job state change."""
        self.broadcast("job.state_changed", {"id": job_id, **payload})

    def emit_progress(self, job_id: str, payload: dict[str, Any]):
        """Emit throttled job progress (max 2/sec per job)."""
        now = time.monotonic()
        last_emit = self._job_throttle_state.get(job_id, 0.0)
        
        if now - last_emit >= 0.5:
            self._job_throttle_state[job_id] = now
            self.broadcast("job.progress", {"id": job_id, **payload})

    def emit_group_event(self, event_type: str, group_id: str, payload: dict[str, Any]):
        """Emit unthrottled group event (created, state_changed, deleted)."""
        self.broadcast(f"group.{event_type}", {"id": group_id, **payload})

    def emit_group_progress(self, group_id: str, payload: dict[str, Any]):
        """Emit throttled group progress (max 1/sec per group)."""
        now = time.monotonic()
        last_emit = self._group_throttle_state.get(group_id, 0.0)
        
        if now - last_emit >= 1.0:
            self._group_throttle_state[group_id] = now
            self.broadcast("group.progress", {"id": group_id, **payload})

# Global singleton
event_bus = EventBus()
