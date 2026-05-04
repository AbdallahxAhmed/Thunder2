# Implementation Plan: Unified Headless Download Daemon (Thunder)

**Branch**: `001-thunder-download-daemon` | **Date**: 2026-04-26 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/001-thunder-download-daemon/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

Build a headless, API-driven download daemon that exposes a FastAPI REST API to accept
download requests and routes them to one of three engines: aria2 (via JSON-RPC for standard
file downloads), yt-dlp (via Python module import for media site extraction), or N_m3u8DL-RE
(via subprocess for DRM-encrypted streams). All downloads execute asynchronously as background
tasks, returning immediate acknowledgments. A status endpoint allows clients to query download
progress. The architecture is modular — each engine is an isolated client module behind a
common interface, orchestrated by a central router.

## Technical Context

**Language/Version**: Python 3.11+
**Primary Dependencies**: FastAPI, uvicorn, requests, yt-dlp, pydantic
**Storage**: Local filesystem (`downloads/` directory)
**Testing**: pytest, pytest-asyncio, httpx (for async FastAPI test client)
**Target Platform**: Linux (primary), macOS (best-effort)
**Project Type**: web-service (headless daemon)
**Performance Goals**: <2s API response time, 16 parallel connections per aria2 download
**Constraints**: Must run headless (no GUI), single-host deployment, zero-config startup possible
**Scale/Scope**: Single daemon, 3 engines, ~10 API endpoints

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Headless-First | ✅ PASS | No GUI deps. All interaction via REST API. Config via env vars + TOML. |
| II. Smart Routing | ✅ PASS | Deterministic router module: `drm_keys`/`.mpd` → N_m3u8DL-RE, media sites/`.m3u8` → yt-dlp, else → aria2. |
| III. DRM Pipeline Isolation | ✅ PASS | `engines/m3u8_client.py` is fully isolated. Requires explicit `KID:KEY`. No auto-cracking. |
| IV. API-Driven Architecture | ✅ PASS | FastAPI + uvicorn. JSON-only req/res. Background tasks for all downloads. |
| V. Observability & Structured Logging | ✅ PASS | Python `logging` with JSON formatter to `logs/`. Correlation IDs on all jobs. |
| VI. Test-First Discipline | ✅ PASS | pytest + httpx test client. Mocked engines. No network in tests. |
| VII. Simplicity & YAGNI | ✅ PASS | Three engines, flat module structure, no plugin system, no dynamic loading. |

## Project Structure

### Documentation (this feature)

```text
specs/001-thunder-download-daemon/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   └── api.md           # REST API contract
└── tasks.md             # Phase 2 output (/speckit-tasks command)
```

### Source Code (repository root)

```text
src/
├── main.py              # FastAPI app initialization, primary router, lifespan
├── models.py            # Pydantic models (DownloadRequest, DownloadResponse, etc.)
├── router.py            # URL classification + engine routing logic
├── config.py            # Settings from env vars / config file
├── logger.py            # Structured JSON logging setup
├── job_manager.py       # In-memory download job tracking (state machine)
├── engines/
│   ├── __init__.py      # Engine registry + base protocol
│   ├── aria2_client.py  # aria2 JSON-RPC client
│   ├── ytdlp_client.py  # yt-dlp Python module wrapper
│   └── m3u8_client.py   # N_m3u8DL-RE subprocess wrapper
└── health.py            # Startup health checks + /api/health endpoint

tests/
├── conftest.py          # Shared fixtures (test client, mock engines)
├── test_router.py       # URL classification unit tests
├── test_models.py       # Pydantic model validation tests
├── test_api.py          # API endpoint integration tests (mocked engines)
├── test_job_manager.py  # Job state machine tests
└── test_engines/
    ├── test_aria2.py    # aria2 RPC mock tests
    ├── test_ytdlp.py    # yt-dlp mock tests
    └── test_m3u8.py     # N_m3u8DL-RE subprocess mock tests

downloads/               # Default output directory (created at runtime)
logs/                    # Structured JSON log output (created at runtime)
```

**Structure Decision**: Single project layout with `src/` for application code
and `tests/` mirroring the source structure. The `engines/` sub-package isolates
each download backend behind a common protocol. No monorepo, no frontend —
pure headless service.

## Complexity Tracking

> **No violations. All choices align with constitution principles.**

| Decision | Rationale |
|----------|-----------|
| In-memory job store (no DB) | Constitution VII (Simplicity). SQLite or Redis would be premature for v1 single-host daemon. Jobs are ephemeral — lost on restart is acceptable. |
| No abstract base class for engines | Constitution VII (YAGNI). A Python Protocol is sufficient for the 3 known engines. No dynamic discovery needed. |
| `asyncio.create_task` over Celery | Constitution VII (Simplicity). No message broker dependency. Background tasks run in the same event loop. |
