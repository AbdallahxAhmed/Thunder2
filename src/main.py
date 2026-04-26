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

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from src.config import settings
from src.engines import ENGINE_MAP, _register_defaults, get_engine
from src.health import check_all_engines
from src.job_manager import job_manager
from src.logger import correlation_id, setup_logging
from src.models import (
    DownloadRequest,
    DownloadResponse,
    DownloadStatus,
    ErrorResponse,
    HealthResponse,
    StatusResponse,
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
        "UHDD started — %d/%d engines available",
        len(available),
        len(_engine_health),
        extra={"event": "daemon.startup"},
    )

    _start_time = time.time()
    yield
    logger.info("UHDD shutting down", extra={"event": "daemon.shutdown"})


# ── App ───────────────────────────────────────────────────────────────────

app = FastAPI(
    title="Dark Downloader — UHDD",
    description="Unified Headless Download Daemon",
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


# ── Download orchestrator ─────────────────────────────────────────────────


async def _execute_download(job_id: str, request: DownloadRequest) -> None:
    """Run a download in a background thread and update the job store."""
    job = await job_manager.get_job(job_id)
    if job is None:
        return

    engine = get_engine(job.engine)
    if engine is None:
        await job_manager.update_job(
            job_id,
            status=DownloadStatus.FAILED,
            error=f"Engine '{job.engine}' is not registered",
        )
        return

    await job_manager.update_job(job_id, status=DownloadStatus.DOWNLOADING)
    logger.info(
        "Download started: %s via %s",
        job_id,
        job.engine,
        extra={
            "download_id": job_id,
            "engine": job.engine,
            "event": "download.started",
        },
    )

    try:
        result = await asyncio.to_thread(engine.execute, job, request)

        if result.get("status") == "completed":
            await job_manager.update_job(
                job_id,
                status=DownloadStatus.COMPLETED,
                progress=100.0,
                output_path=result.get("output_path"),
                file_size=result.get("file_size"),
            )
            logger.info(
                "Download completed: %s → %s",
                job_id,
                result.get("output_path"),
                extra={
                    "download_id": job_id,
                    "engine": job.engine,
                    "event": "download.completed",
                },
            )
        else:
            error_msg = result.get("error", "Unknown engine error")
            await job_manager.update_job(
                job_id, status=DownloadStatus.FAILED, error=error_msg
            )
            logger.error(
                "Download failed: %s — %s",
                job_id,
                error_msg,
                extra={
                    "download_id": job_id,
                    "engine": job.engine,
                    "event": "download.failed",
                },
            )
    except Exception as exc:
        await job_manager.update_job(
            job_id, status=DownloadStatus.FAILED, error=str(exc)
        )
        logger.exception(
            "Download crashed: %s",
            job_id,
            extra={
                "download_id": job_id,
                "engine": job.engine,
                "event": "download.failed",
            },
        )


# ── Endpoints ─────────────────────────────────────────────────────────────


@app.post("/api/download", status_code=202, response_model=DownloadResponse)
async def submit_download(request: DownloadRequest) -> JSONResponse:
    """Accept a download request, classify, and dispatch to the right engine."""
    engine_name = classify(request.url, request.drm_keys)

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

    job = await job_manager.create_job(url=request.url, engine=engine_name)

    # Fire-and-forget background task
    asyncio.create_task(_execute_download(job.id, request))

    return JSONResponse(
        status_code=202,
        content=DownloadResponse(
            id=job.id,
            status=job.status.value,
            engine=engine_name,
        ).model_dump(),
    )


@app.get("/api/download/{job_id}")
async def get_download_status(job_id: str) -> JSONResponse:
    """Query the current status of a download job."""
    job = await job_manager.get_job(job_id)
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
            id=job.id,
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
