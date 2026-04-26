# Tasks: Unified Headless Download Daemon (UHDD)

**Input**: Design documents from `specs/001-uhdd-download-daemon/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Included per constitution Principle VI (Test-First Discipline).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root
- Paths shown below use the single project layout from plan.md

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

- [x] T001 Create project directory structure: `src/`, `src/engines/`, `tests/`, `tests/test_engines/`
- [x] T002 Initialize Python project with `requirements.txt` containing: `fastapi`, `uvicorn[standard]`, `requests`, `yt-dlp`, `pydantic`, `pydantic-settings`
- [x] T003 [P] Create dev dependencies in `requirements-dev.txt`: `pytest`, `pytest-asyncio`, `httpx`, `pytest-cov`
- [x] T004 [P] Create `src/__init__.py` and `src/engines/__init__.py` and `tests/__init__.py` and `tests/test_engines/__init__.py` package files
- [x] T005 [P] Create `.gitignore` with Python defaults, `downloads/`, `logs/`, `.venv/`, `__pycache__/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T006 Implement application settings in `src/config.py` using pydantic `BaseSettings` with fields: `aria2_rpc_url`, `aria2_rpc_secret`, `download_dir`, `log_dir`, `log_level` and defaults from research.md R8
- [x] T007 [P] Implement structured JSON logging setup in `src/logger.py` with JSON formatter, correlation ID injection, and sensitive field redaction filter (tokens, keys)
- [x] T008 [P] Implement Pydantic models in `src/models.py`: `DownloadRequest` (url, cookies, user_agent, drm_keys with KID:KEY regex validation), `DownloadJob` (id, url, engine, status, progress, speed, output_path, file_size, error, created_at, updated_at, aria2_gid), `DownloadStatus` enum (queued, downloading, completed, failed), `DownloadResponse`, `StatusResponse`, `ErrorResponse`, `EngineHealth`, `HealthResponse`
- [x] T009 Implement job manager in `src/job_manager.py` with in-memory `dict[str, DownloadJob]` protected by `asyncio.Lock`: methods `create_job(url, engine) -> DownloadJob`, `get_job(id) -> DownloadJob | None`, `update_job(id, **fields)`, `list_jobs() -> list[DownloadJob]`
- [x] T010 Implement URL classification router in `src/router.py` with deterministic 5-rule routing: (1) drm_keys present → m3u8, (2) URL ends `.mpd` → m3u8, (3) URL domain matches known media sites → ytdlp, (4) URL ends `.m3u8` → ytdlp, (5) else → aria2. Include `KNOWN_MEDIA_DOMAINS` set (youtube.com, youtu.be, twitter.com, x.com, vimeo.com, dailymotion.com, twitch.tv, tiktok.com, instagram.com)
- [x] T011 Implement engine health check utilities in `src/health.py`: `check_aria2()` (ping RPC), `check_ytdlp()` (import version), `check_m3u8()` (shutil.which N_m3u8DL-RE), `check_all_engines() -> list[EngineHealth]`

**Checkpoint**: Foundation ready — user story implementation can now begin

---

## Phase 3: User Story 1 — Submit a Standard File Download (Priority: P1) 🎯 MVP

**Goal**: Accept a URL via POST /api/download, route it to aria2, execute the download asynchronously, save the file to `downloads/`

**Independent Test**: Submit a direct HTTPS file URL via the API, verify acknowledgment response, and confirm the file appears in `downloads/`

### Tests for User Story 1 ⚠️

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T012 [P] [US1] Create test fixtures and shared mocks in `tests/conftest.py`: FastAPI `AsyncClient` via httpx, mock aria2 RPC responses, mock settings
- [x] T013 [P] [US1] Write unit tests for aria2 client in `tests/test_engines/test_aria2.py`: test `add_download()` sends correct JSON-RPC payload with split=16 and auth token, test `get_status()` parses aria2 response, test connection error handling
- [x] T014 [P] [US1] Write API integration tests in `tests/test_api.py`: test POST /api/download with standard URL returns 202 with job ID, test POST with missing URL returns 422, test POST when aria2 unavailable returns 503

### Implementation for User Story 1

- [x] T015 [US1] Implement aria2 JSON-RPC client in `src/engines/aria2_client.py`: `add_download(url, cookies, user_agent, download_dir) -> gid` using `requests.post()` with `aria2.addUri`, split=16, max-connection-per-server=16, min-split-size=1M; `get_status(gid) -> dict` using `aria2.tellStatus`; `remove_download(gid)` using `aria2.remove`; all calls authenticated with `token:{secret}`
- [x] T016 [US1] Implement engine protocol and registry in `src/engines/__init__.py`: define `EngineProtocol` with `async def execute(job: DownloadJob, request: DownloadRequest)` signature; create `ENGINE_MAP: dict[str, EngineProtocol]` mapping engine names to client instances
- [x] T017 [US1] Implement download orchestrator function in `src/main.py`: `async def _execute_download(job_id, request)` that resolves engine from router, updates job to `downloading`, calls `await asyncio.to_thread(engine.execute, ...)`, updates job to `completed`/`failed` with output path or error message
- [x] T018 [US1] Implement FastAPI app and POST /api/download endpoint in `src/main.py`: create FastAPI app with lifespan (create `downloads/` and `logs/` dirs on startup, run health checks); POST endpoint validates request, calls `router.classify(request)`, creates job via job_manager, spawns `asyncio.create_task(_execute_download(...))`, returns 202 with `DownloadResponse(id, status="queued", engine)`
- [x] T019 [US1] Add error handling for engine unavailability in `src/main.py`: if health check shows target engine is unavailable, return 503 with `ErrorResponse(error_code="ENGINE_UNAVAILABLE")`

**Checkpoint**: At this point, User Story 1 should be fully functional — submit a file URL, get acknowledgment, file downloads via aria2

---

## Phase 4: User Story 2 — Download Media from a Supported Site (Priority: P2)

**Goal**: Route media site URLs (YouTube, Twitter, etc.) and `.m3u8` URLs to yt-dlp, download best video+audio, mux into `.mp4`

**Independent Test**: Submit a YouTube URL via the API, verify yt-dlp engine is selected, and confirm muxed media file in `downloads/`

### Tests for User Story 2 ⚠️

- [x] T020 [P] [US2] Write unit tests for yt-dlp client in `tests/test_engines/test_ytdlp.py`: test `execute()` calls `yt_dlp.YoutubeDL.download()` with correct opts (format, outtmpl, merge_output_format), test progress hook emits structured log, test extraction failure returns error
- [x] T021 [P] [US2] Write URL router tests for media site classification in `tests/test_router.py`: test YouTube URL → ytdlp, test Twitter URL → ytdlp, test `.m3u8` URL without drm_keys → ytdlp, test unknown URL → aria2, test `.mpd` URL → m3u8, test drm_keys present → m3u8 regardless of URL

### Implementation for User Story 2

- [x] T022 [US2] Implement yt-dlp engine client in `src/engines/ytdlp_client.py`: `execute(job, request)` method that configures `yt_dlp.YoutubeDL` with `format='bestvideo+bestaudio/best'`, `outtmpl='downloads/%(title).200s.%(ext)s'`, `merge_output_format='mp4'`, passes cookies/user_agent from request, uses progress_hooks to update job progress via job_manager, runs download in `asyncio.to_thread()`
- [x] T023 [US2] Register yt-dlp engine in `src/engines/__init__.py` ENGINE_MAP under key `ytdlp`
- [x] T024 [US2] Add API integration test in `tests/test_api.py`: test POST /api/download with YouTube URL returns 202 with engine="ytdlp"

**Checkpoint**: User Stories 1 AND 2 should both work independently — standard files via aria2, media via yt-dlp

---

## Phase 5: User Story 3 — Check Download Status (Priority: P2)

**Goal**: Query download progress and state via GET /api/download/{id}

**Independent Test**: Submit a download, then query its status endpoint and verify correct state and progress info

### Tests for User Story 3 ⚠️

- [x] T025 [P] [US3] Write unit tests for job manager in `tests/test_job_manager.py`: test `create_job()` returns job with status=queued and valid UUID, test `get_job()` returns correct job, test `update_job()` transitions state correctly, test `get_job()` with invalid ID returns None
- [x] T026 [P] [US3] Write API tests for status endpoint in `tests/test_api.py`: test GET /api/download/{id} returns 200 with correct status, test GET with unknown ID returns 404 with JOB_NOT_FOUND error, test status response includes progress/speed for downloading jobs, test completed job includes output_path and file_size

### Implementation for User Story 3

- [x] T027 [US3] Implement GET /api/download/{id} endpoint in `src/main.py`: look up job via job_manager.get_job(id), return 200 with `StatusResponse` if found, return 404 with `ErrorResponse(error_code="JOB_NOT_FOUND")` if not found
- [x] T028 [US3] Implement GET /api/health endpoint in `src/main.py`: call `health.check_all_engines()`, return `HealthResponse` with engine availability list and daemon uptime, return 503 if zero engines available

**Checkpoint**: All P1 and P2 stories functional — downloads, media, and status checks

---

## Phase 6: User Story 4 — Download a DRM-Encrypted Stream (Priority: P3)

**Goal**: Route DRM requests (drm_keys present or `.mpd` URL) to N_m3u8DL-RE, decrypt and mux stream

**Independent Test**: Submit a manifest URL with KID:KEY pair, verify N_m3u8DL-RE engine selected and decrypted file in `downloads/`

### Tests for User Story 4 ⚠️

- [x] T029 [P] [US4] Write unit tests for N_m3u8DL-RE client in `tests/test_engines/test_m3u8.py`: test `execute()` builds correct subprocess command with `--key`, `--save-dir`, `--save-name`, `--auto-select`, `--del-after-done`, test stdout/stderr captured and logged, test non-zero return code produces error
- [x] T030 [P] [US4] Write API test for DRM download in `tests/test_api.py`: test POST /api/download with drm_keys returns 202 with engine="m3u8", test POST with `.mpd` URL (no drm_keys) returns engine="m3u8"

### Implementation for User Story 4

- [x] T031 [US4] Implement N_m3u8DL-RE engine client in `src/engines/m3u8_client.py`: `execute(job, request)` method that builds command list `["N_m3u8DL-RE", manifest_url, "--key", drm_keys, "--save-dir", download_dir, "--save-name", output_name, "--auto-select", "--del-after-done"]`, runs via `subprocess.run(capture_output=True, text=True)` in `asyncio.to_thread()`, logs stdout/stderr, updates job status on completion/failure
- [x] T032 [US4] Register N_m3u8DL-RE engine in `src/engines/__init__.py` ENGINE_MAP under key `m3u8`
- [x] T033 [US4] Add DRM-specific validation: if request has `drm_keys`, validate KID:KEY format regex in `src/models.py` validator; if `.mpd` URL detected without `drm_keys`, log a warning that decryption may fail

**Checkpoint**: All user stories functional — standard files, media, status, and DRM streams

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T034 [P] Add comprehensive edge case handling in `src/main.py`: duplicate URL acceptance (no dedup), disk space check before downloads, malformed JSON → 422
- [x] T035 [P] Add filename sanitization in `src/engines/aria2_client.py` and `src/engines/ytdlp_client.py`: truncate filenames to 200 chars excluding extension
- [x] T036 [P] Implement startup validation in `src/main.py` lifespan: verify `downloads/` and `logs/` directories are writable, warn on missing engines without crashing
- [x] T037 [P] Write model validation unit tests in `tests/test_models.py`: test DownloadRequest URL validation, test drm_keys regex validation, test DownloadStatus enum values
- [x] T038 Add request correlation via `X-Request-ID` header in `src/main.py`: extract from request headers if present, generate UUID if absent, inject into logger context
- [ ] T039 Run full test suite and validate all tests pass: `pytest tests/ -v --cov=src --cov-report=term-missing`
- [ ] T040 Run quickstart.md validation: verify all documented commands work end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P2 → P3)
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) — No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) — Uses engine registry from US1 but independently testable
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) — Uses job_manager from Phase 2, independent of engine stories
- **User Story 4 (P3)**: Can start after Foundational (Phase 2) — Uses engine registry pattern from US1 but independently testable

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Models/entities before services/clients
- Engine client before API endpoint integration
- Core implementation before error handling
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel (T003, T004, T005)
- All Foundational tasks marked [P] can run in parallel (T007, T008)
- Once Foundational phase completes, all user stories can start in parallel
- All tests for a user story marked [P] can run in parallel
- All Polish tasks marked [P] can run in parallel (T034, T035, T036, T037)

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
Task: T012 "Create test fixtures and shared mocks in tests/conftest.py"
Task: T013 "Write unit tests for aria2 client in tests/test_engines/test_aria2.py"
Task: T014 "Write API integration tests in tests/test_api.py"
```

## Parallel Example: Foundational Phase

```bash
# Launch parallelizable foundational tasks:
Task: T007 "Implement structured JSON logging in src/logger.py"
Task: T008 "Implement Pydantic models in src/models.py"

# Then sequential:
Task: T009 "Implement job manager in src/job_manager.py" (depends on T008)
Task: T010 "Implement URL router in src/router.py"
Task: T011 "Implement health checks in src/health.py"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL — blocks all stories)
3. Complete Phase 3: User Story 1 (aria2 standard downloads)
4. **STOP and VALIDATE**: Test User Story 1 independently
5. Deploy/demo if ready

### Incremental Delivery

1. Complete Setup + Foundational → Foundation ready
2. Add User Story 1 → Test independently → Deploy (MVP!)
3. Add User Story 2 (yt-dlp) → Test independently → Deploy
4. Add User Story 3 (status endpoint) → Test independently → Deploy
5. Add User Story 4 (DRM/N_m3u8DL-RE) → Test independently → Deploy
6. Each story adds value without breaking previous stories

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (aria2)
   - Developer B: User Story 2 (yt-dlp)
   - Developer C: User Story 3 (status) + User Story 4 (DRM)
3. Stories complete and integrate independently

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- Avoid: vague tasks, same file conflicts, cross-story dependencies that break independence
