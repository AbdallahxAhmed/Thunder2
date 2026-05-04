"""FastAPI application — primary router, download orchestrator, and endpoints.

All downloads execute as background tasks via ``asyncio.create_task`` +
``asyncio.to_thread`` so the API never blocks on engine I/O.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, Query, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import yt_dlp

from src.config import settings
from src.engines import ENGINE_MAP, _register_defaults, get_engine
from src.health import check_all_engines
from src.queue_manager import queue_manager, ActiveJobState
from src.event_bus import event_bus
from src.logger import correlation_id, setup_logging
from src.models import (
    DownloadRequest,
    DownloadResponse,
    DownloadStatus,
    ErrorResponse,
    HealthResponse,
    StatusResponse,
    InfoResponse,
    QualityOption,
    JobActionResponse,
    JobListItem,
    JobListResponse,
    GroupCreateRequest,
    GroupListItem,
    GroupListResponse,
    GroupDetailResponse,
    SettingsResponse,
    SettingsUpdateRequest,
)
from src.router import classify

logger = logging.getLogger(__name__)

# ── Global state ──────────────────────────────────────────────────────────

_start_time: float = 0.0
_engine_health: list[Any] = []

# ── Lifespan ──────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle hook."""
    global _start_time, _engine_health

    # Logging
    setup_logging(log_dir=settings.log_dir, log_level=settings.log_level)

    # Ensure runtime directories exist
    os.makedirs(settings.download_dir, exist_ok=True)
    os.makedirs(settings.log_dir, exist_ok=True)

    # Register engine clients
    _register_defaults()

    # Startup health check
    _engine_health = await asyncio.to_thread(check_all_engines)
    available = [e for e in _engine_health if e.available]
    logger.info(
        "Thunder started — %d/%d engines available",
        len(available),
        len(_engine_health),
        extra={"event": "daemon.startup"},
    )

    _start_time = time.time()

    # Initialize QueueManager (creates DB, loads cache, starts scheduler)
    await queue_manager.init()

    yield

    # Shutdown QueueManager (cancels scheduler, cleans up)
    await queue_manager.shutdown()
    logger.info("Thunder shutting down", extra={"event": "daemon.shutdown"})


# ── App ───────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Thunder",
    description="Universal Headless DRM Downloader",
    version="0.1.0",
    lifespan=lifespan,
)

# ── Error handlers ────────────────────────────────────────────────────────


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request, exc: RequestValidationError
) -> JSONResponse:
    """Return structured 422 errors matching the ErrorResponse schema."""
    details = []
    for err in exc.errors():
        field = ".".join(str(loc) for loc in err.get("loc", []))
        details.append({"field": field, "message": err.get("msg", "")})
    return JSONResponse(
        status_code=422,
        content={
            "error_code": "VALIDATION_ERROR",
            "message": "Request validation failed",
            "details": details,
        },
    )


# ── Middleware (X-Request-ID correlation) ─────────────────────────────────


@app.middleware("http")
async def request_correlation_middleware(request: Request, call_next):
    """Inject a correlation ID into every request context."""
    req_id = request.headers.get("X-Request-ID", str(uuid.uuid4()))
    token = correlation_id.set(req_id)
    response = await call_next(request)
    response.headers["X-Request-ID"] = req_id
    correlation_id.reset(token)
    return response


# ── Download orchestration is now handled by QueueManager ─────────────────


# ── Endpoints ─────────────────────────────────────────────────────────────


@app.post("/api/download", status_code=202, response_model=DownloadResponse)
async def submit_download(request: DownloadRequest) -> JSONResponse:
    """Accept a download request, classify, and dispatch to the right engine."""
    if request.engine:
        engine_name = request.engine
    else:
        engine_name = classify(
            request.url,
            drm_keys=request.drm_keys,
            pssh=request.pssh,
            license_url=request.license_url,
            drm_hint=request.drm_hint,
        )

    # Check engine availability
    engine_status = next(
        (e for e in _engine_health if e.name == engine_name), None
    )
    if engine_status and not engine_status.available:
        return JSONResponse(
            status_code=503,
            content={
                "error_code": "ENGINE_UNAVAILABLE",
                "message": f"{engine_name} engine is not available: {engine_status.error}",
                "engine": engine_name,
            },
        )

    job_id = str(uuid.uuid4())
    job = await queue_manager.create_job(
        job_id=job_id, url=request.url, engine=engine_name,
    )

    return JSONResponse(
        status_code=202,
        content=DownloadResponse(
            id=job.job_id,
            status=job.status.value,
            engine=engine_name,
        ).model_dump(),
    )


@app.get("/api/download/{job_id}")
async def get_download_status(job_id: str) -> JSONResponse:
    """Query the current status of a download job."""
    job = await queue_manager.get_job(job_id)
    if job is None:
        return JSONResponse(
            status_code=404,
            content=ErrorResponse(
                error_code="JOB_NOT_FOUND",
                message=f"No download job found with ID: {job_id}",
            ).model_dump(),
        )
    return JSONResponse(
        content=StatusResponse(
            id=job.job_id,
            url=job.url,
            engine=job.engine,
            status=job.status.value,
            progress=job.progress,
            speed=job.speed,
            output_path=job.output_path,
            file_size=job.file_size,
            error=job.error,
            created_at=job.created_at,
            updated_at=job.updated_at,
        ).model_dump(mode="json"),
    )


@app.get("/api/info", response_model=InfoResponse)
async def get_media_info(
    url: str = Query(..., min_length=1),
    drm_hint: bool = Query(
        default=False, description="Hint that DRM/manifest signals were detected"
    ),
) -> JSONResponse:
    """Query available formats for a media URL via yt-dlp.

    Returns a curated, quality-obsessed list of resolution tiers.
    Every video option uses ``bestvideo[height<=H]+bestaudio/best``
    to guarantee merged audio+video in the download.  Tiers are only
    included when the source actually has formats at that resolution.
    """
    engine = get_engine("ytdlp")
    if engine is None:
        return JSONResponse(
            status_code=503,
            content=ErrorResponse(
                error_code="ENGINE_UNAVAILABLE",
                message="ytdlp engine is not available",
            ).model_dump(),
        )

    try:
        info = await asyncio.to_thread(engine.extract_info, url)
    except yt_dlp.utils.DownloadError as exc:
        if drm_hint:
            resp = InfoResponse(
                url=url,
                status="unsupported",
                suggested_engine="m3u8",
                reason="yt-dlp could not extract info; DRM/manifest hint provided",
                options=[],
            )
            return JSONResponse(content=resp.model_dump(mode="json"))
        resp = InfoResponse(
            url=url,
            status="unsupported",
            reason="yt-dlp could not extract info from this URL",
            options=[],
        )
        return JSONResponse(content=resp.model_dump(mode="json"))
    except Exception as exc:
        logger.warning("Unsupported URL in /api/info: %s — %s", url, exc)
        resp = InfoResponse(
            url=url,
            status="unsupported",
            reason=str(exc),
            options=[],
        )
        return JSONResponse(content=resp.model_dump(mode="json"))

    # ── Analyse available video formats ────────────────────────────────
    # Collect the set of heights that actually exist, along with codec
    # quality metadata so we can annotate badges.
    available_heights: set[int] = set()
    # Track best codec per height for badge logic
    codec_rank = {"av01": 3, "vp9": 2, "vp09": 2, "avc1": 1, "h264": 1}
    best_codec_per_height: dict[int, str] = {}   # height → best codec prefix
    best_tbr_per_height: dict[int, float] = {}   # height → best total bitrate

    for f in info.get("formats", []):
        h = f.get("height")
        vcodec = f.get("vcodec") or ""
        if not h or not isinstance(h, (int, float)) or vcodec == "none":
            continue
        h = int(h)
        available_heights.add(h)

        # Score codec
        codec_prefix = vcodec.split(".")[0].lower()
        rank = codec_rank.get(codec_prefix, 0)
        prev_rank = codec_rank.get(best_codec_per_height.get(h, ""), 0)
        if rank > prev_rank:
            best_codec_per_height[h] = codec_prefix

        # Track best bitrate
        tbr = f.get("tbr") or 0
        if tbr > best_tbr_per_height.get(h, 0):
            best_tbr_per_height[h] = tbr

    max_height = max(available_heights) if available_heights else 0

    # ── Build opinionated quality tiers ────────────────────────────────
    # Full resolution ladder — only tiers the source supports.
    # The max resolution is folded into "Best Quality (Xp)" and its
    # standalone tier is suppressed to avoid redundancy.
    TIERS = [
        (2160, "4K (2160p)", "4K"),
        (1440, "1440p",      "QHD"),
        (1080, "1080p",      "HD"),
        (720,  "720p",       "HD"),
        (480,  "480p",       None),
        (360,  "360p",       None),
        (240,  "240p",       None),
        (144,  "144p",       None),
    ]

    # Map height → human label for the "Best Quality" heading
    height_labels = {h: lbl for h, lbl, _ in TIERS}
    best_label_suffix = height_labels.get(max_height, f"{max_height}p") if max_height > 0 else ""

    options: list[QualityOption] = []

    # Lead with merged "Best Quality (Xp)"
    best_badge = "4K" if max_height >= 2160 else "HD" if max_height >= 720 else None
    options.append(QualityOption(
        label=f"Best Quality ({best_label_suffix})" if best_label_suffix else "Best Quality",
        format_id="bestvideo+bestaudio/best",
        type="video",
        badge=best_badge,
    ))

    # Resolution tiers — skip the tier that matches max_height (already
    # covered by "Best Quality") to eliminate the redundant button.
    for height, label, badge in TIERS:
        if height == max_height:
            continue  # folded into Best Quality above
        if max_height >= height:
            # If best codec at this height is vp9/av01 → mark as HQ
            bc = best_codec_per_height.get(height, "")
            effective_badge = badge
            if bc in ("av01", "vp9", "vp09") and height >= 720:
                effective_badge = "HQ" if badge is None else badge

            options.append(QualityOption(
                label=label,
                format_id=f"bestvideo[height<={height}]+bestaudio/best",
                type="video",
                badge=effective_badge,
            ))

    # Always offer Audio Only
    options.append(QualityOption(
        label="Audio Only (best)",
        format_id="bestaudio/best",
        type="audio",
        badge=None,
    ))

    resp = InfoResponse(
        url=url,
        status="ok",
        title=info.get("title"),
        thumbnail=info.get("thumbnail"),
        duration=info.get("duration"),
        max_height=max_height if max_height > 0 else None,
        options=options,
    )

    return JSONResponse(content=resp.model_dump(mode="json"))


@app.get("/api/health", response_model=HealthResponse)
async def health_check() -> JSONResponse:
    """Report daemon health and engine availability."""
    global _engine_health
    _engine_health = await asyncio.to_thread(check_all_engines)

    any_available = any(e.available for e in _engine_health)
    status_code = 200 if any_available else 503
    status_label = "healthy" if any_available else "degraded"
    uptime = time.time() - _start_time

    return JSONResponse(
        status_code=status_code,
        content=HealthResponse(
            status=status_label,
            uptime_seconds=round(uptime, 1),
            engines=[e.model_dump() for e in _engine_health],
        ).model_dump(),
    )


# ── Phase 7: Queue Management REST API ────────────────────────────────────


@app.get("/api/jobs", response_model=JobListResponse)
async def list_jobs(
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    status: str | None = Query(default=None),
    engine: str | None = Query(default=None),
    group_id: str | None = Query(default=None),
) -> JSONResponse:
    """Paginated, filterable list of all jobs."""
    jobs = await queue_manager.list_jobs(
        limit=limit, offset=offset, status=status, engine=engine, group_id=group_id
    )
    total = await queue_manager.count_jobs(status=status, engine=engine, group_id=group_id)

    items = [
        JobListItem(
            id=j.job_id,
            url=j.url,
            engine=j.engine,
            status=j.status.value if isinstance(j.status, DownloadStatus) else j.status,
            progress=j.progress,
            speed=j.speed,
            eta=j.eta,
            output_path=j.output_path,
            file_size=j.file_size,
            error=j.error,
            group_id=j.group_id,
            title=j.title,
            created_at=j.created_at,
            updated_at=j.updated_at,
        )
        for j in jobs
    ]

    return JSONResponse(
        content=JobListResponse(
            jobs=items, total=total, limit=limit, offset=offset
        ).model_dump(mode="json")
    )


@app.post("/api/jobs/{job_id}/pause", response_model=JobActionResponse)
async def pause_job(job_id: str) -> JSONResponse:
    """Pause a downloading job."""
    try:
        await queue_manager.pause_job(job_id)
    except ValueError as e:
        return JSONResponse(
            status_code=409,
            content=ErrorResponse(
                error_code="INVALID_STATE_TRANSITION", message=str(e)
            ).model_dump(),
        )
    return JSONResponse(
        content=JobActionResponse(
            id=job_id, action="pause", status="paused", message="Job paused"
        ).model_dump()
    )


@app.post("/api/jobs/{job_id}/resume", response_model=JobActionResponse)
async def resume_job(job_id: str) -> JSONResponse:
    """Resume a paused job."""
    try:
        await queue_manager.resume_job(job_id)
    except ValueError as e:
        return JSONResponse(
            status_code=409,
            content=ErrorResponse(
                error_code="INVALID_STATE_TRANSITION", message=str(e)
            ).model_dump(),
        )
    return JSONResponse(
        content=JobActionResponse(
            id=job_id, action="resume", status="queued", message="Job resumed"
        ).model_dump()
    )


@app.post("/api/jobs/{job_id}/cancel", response_model=JobActionResponse)
async def cancel_job(job_id: str) -> JSONResponse:
    """Cancel a job."""
    try:
        await queue_manager.cancel_job(job_id)
    except ValueError as e:
        return JSONResponse(
            status_code=409,
            content=ErrorResponse(
                error_code="INVALID_STATE_TRANSITION", message=str(e)
            ).model_dump(),
        )
    return JSONResponse(
        content=JobActionResponse(
            id=job_id, action="cancel", status="cancelled", message="Job cancelled"
        ).model_dump()
    )


@app.post("/api/jobs/{job_id}/retry", response_model=JobActionResponse)
async def retry_job(job_id: str) -> JSONResponse:
    """Retry a failed job."""
    try:
        await queue_manager.retry_job(job_id)
    except ValueError as e:
        return JSONResponse(
            status_code=409,
            content=ErrorResponse(
                error_code="INVALID_STATE_TRANSITION", message=str(e)
            ).model_dump(),
        )
    return JSONResponse(
        content=JobActionResponse(
            id=job_id, action="retry", status="queued", message="Job retried"
        ).model_dump()
    )


@app.delete("/api/jobs/{job_id}", response_model=JobActionResponse)
async def delete_job(job_id: str) -> JSONResponse:
    """Delete a job."""
    job = await queue_manager.get_job(job_id)
    if job is None:
        return JSONResponse(
            status_code=404,
            content=ErrorResponse(
                error_code="JOB_NOT_FOUND",
                message=f"No download job found with ID: {job_id}",
            ).model_dump(),
        )
    await queue_manager.delete_job(job_id)
    return JSONResponse(
        content=JobActionResponse(
            id=job_id, action="delete", status="deleted", message="Job deleted"
        ).model_dump()
    )


# ── Groups ────────────────────────────────────────────────────────────────


@app.post("/api/groups", status_code=201, response_model=GroupDetailResponse)
async def create_group(request: GroupCreateRequest) -> JSONResponse:
    """Create a download group, optionally with initial jobs."""
    group_id = str(uuid.uuid4())
    group = await queue_manager.create_group(
        group_id=group_id, name=request.name, source_url=request.source_url
    )

    # Create child jobs if URLs provided
    engine_override = request.engine
    for url in request.urls:
        job_engine = engine_override or classify(url)
        job_id = str(uuid.uuid4())
        await queue_manager.create_job(
            job_id=job_id, url=url, engine=job_engine, group_id=group_id
        )

    # Fetch full group with jobs
    detail = await queue_manager.get_group(group_id)
    jobs = [
        JobListItem(
            id=j["id"], url=j["url"], engine=j["engine"], status=j["status"],
            progress=j.get("progress"), speed=j.get("speed"), eta=j.get("eta"),
            output_path=j.get("output_path"), file_size=j.get("file_size"),
            error=j.get("error"), group_id=j.get("group_id"), title=j.get("title"),
            created_at=j["created_at"], updated_at=j["updated_at"],
        )
        for j in (detail.get("jobs", []) if detail else [])
    ]

    return JSONResponse(
        status_code=201,
        content=GroupDetailResponse(
            id=group_id, name=request.name, source_url=request.source_url,
            status="active", jobs=jobs,
            created_at=group["created_at"], updated_at=group["updated_at"],
        ).model_dump(mode="json"),
    )


@app.get("/api/groups", response_model=GroupListResponse)
async def list_groups() -> JSONResponse:
    """List all groups with aggregate counts."""
    rows = await queue_manager.list_groups()
    items = [
        GroupListItem(
            id=r["id"], name=r["name"], source_url=r.get("source_url"),
            status=r["status"], total_jobs=r.get("total_jobs", 0),
            completed_jobs=r.get("completed_jobs", 0),
            failed_jobs=r.get("failed_jobs", 0),
            created_at=r["created_at"], updated_at=r["updated_at"],
        )
        for r in rows
    ]
    return JSONResponse(
        content=GroupListResponse(groups=items, total=len(items)).model_dump(mode="json")
    )


@app.get("/api/groups/{group_id}", response_model=GroupDetailResponse)
async def get_group(group_id: str) -> JSONResponse:
    """Get a group with its jobs."""
    detail = await queue_manager.get_group(group_id)
    if detail is None:
        return JSONResponse(
            status_code=404,
            content=ErrorResponse(
                error_code="GROUP_NOT_FOUND",
                message=f"No group found with ID: {group_id}",
            ).model_dump(),
        )
    jobs = [
        JobListItem(
            id=j["id"], url=j["url"], engine=j["engine"], status=j["status"],
            progress=j.get("progress"), speed=j.get("speed"), eta=j.get("eta"),
            output_path=j.get("output_path"), file_size=j.get("file_size"),
            error=j.get("error"), group_id=j.get("group_id"), title=j.get("title"),
            created_at=j["created_at"], updated_at=j["updated_at"],
        )
        for j in detail.get("jobs", [])
    ]
    return JSONResponse(
        content=GroupDetailResponse(
            id=detail["id"], name=detail["name"],
            source_url=detail.get("source_url"), status=detail["status"],
            jobs=jobs, created_at=detail["created_at"],
            updated_at=detail["updated_at"],
        ).model_dump(mode="json")
    )


@app.post("/api/groups/{group_id}/pause", response_model=JobActionResponse)
async def pause_group(group_id: str) -> JSONResponse:
    """Pause all downloading jobs in a group."""
    count = await queue_manager.pause_group(group_id)
    return JSONResponse(
        content=JobActionResponse(
            id=group_id, action="pause_group", status="paused",
            message=f"Paused {count} job(s)",
        ).model_dump()
    )


@app.post("/api/groups/{group_id}/resume", response_model=JobActionResponse)
async def resume_group(group_id: str) -> JSONResponse:
    """Resume all paused jobs in a group."""
    count = await queue_manager.resume_group(group_id)
    return JSONResponse(
        content=JobActionResponse(
            id=group_id, action="resume_group", status="active",
            message=f"Resumed {count} job(s)",
        ).model_dump()
    )


@app.delete("/api/groups/{group_id}", response_model=JobActionResponse)
async def delete_group(group_id: str) -> JSONResponse:
    """Delete a group and dissociate its jobs."""
    deleted = await queue_manager.delete_group(group_id)
    if not deleted:
        return JSONResponse(
            status_code=404,
            content=ErrorResponse(
                error_code="GROUP_NOT_FOUND",
                message=f"No group found with ID: {group_id}",
            ).model_dump(),
        )
    return JSONResponse(
        content=JobActionResponse(
            id=group_id, action="delete_group", status="deleted",
            message="Group deleted",
        ).model_dump()
    )


# ── Settings ──────────────────────────────────────────────────────────────


@app.get("/api/settings", response_model=SettingsResponse)
async def get_settings() -> JSONResponse:
    """Get all runtime settings."""
    settings_data = await queue_manager.get_settings()
    return JSONResponse(
        content=SettingsResponse(settings=settings_data).model_dump()
    )


@app.put("/api/settings", response_model=SettingsResponse)
async def update_settings(request: SettingsUpdateRequest) -> JSONResponse:
    """Update runtime settings (concurrency limits, etc.)."""
    # Validate concurrency limits
    for key, value in request.settings.items():
        if "limit" in key or "concurrent" in key:
            try:
                int_val = int(value)
                if int_val < 1:
                    return JSONResponse(
                        status_code=422,
                        content=ErrorResponse(
                            error_code="VALIDATION_ERROR",
                            message=f"Setting '{key}' must be >= 1, got {value}",
                        ).model_dump(),
                    )
            except ValueError:
                return JSONResponse(
                    status_code=422,
                    content=ErrorResponse(
                        error_code="VALIDATION_ERROR",
                        message=f"Setting '{key}' must be an integer, got '{value}'",
                    ).model_dump(),
                )
    updated = await queue_manager.update_settings(request.settings)
    return JSONResponse(
        content=SettingsResponse(settings=updated).model_dump()
    )


# ── Phase 8: WebSocket Event Bus ─────────────────────────────────────────

@app.websocket("/api/ws/events")
async def websocket_endpoint(websocket: WebSocket):
    """Real-time event stream for GUI clients (read-only)."""
    await websocket.accept()
    await event_bus.connect(websocket)
    try:
        while True:
            # Consume and discard client messages (read-only enforcement)
            await websocket.receive_text()
    except WebSocketDisconnect:
        await event_bus.disconnect(websocket)

