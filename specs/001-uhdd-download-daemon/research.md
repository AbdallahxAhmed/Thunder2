# Research: Unified Headless Download Daemon (UHDD)

**Date**: 2026-04-26
**Feature**: [spec.md](spec.md)
**Purpose**: Resolve all technical unknowns and document key decisions.

## R1: aria2 JSON-RPC Integration Pattern

**Decision**: Use synchronous `requests.post()` to `http://localhost:6800/jsonrpc` with
JSON-RPC 2.0 payloads. Wrap in an async executor (`asyncio.to_thread`) to avoid blocking
the FastAPI event loop.

**Rationale**: aria2's RPC interface is HTTP-based and well-documented. The `requests`
library is the simplest HTTP client with no async complexity. Since aria2 RPC calls are
fast (they queue work, not execute it), the thread-pool overhead is negligible. This
aligns with the existing `aria2_rpc.md` skill.

**Alternatives considered**:
- `aiohttp` for native async: More complex, adds a dependency, minimal benefit for
  sub-millisecond RPC calls.
- `httpx` async client: Good option but `requests` is already needed; adding `httpx`
  for production while using it in tests only would be redundant. We use `httpx` only
  in tests (for `AsyncClient`).

**Key Parameters**:
- `aria2.addUri` — add download with `[url]`, options: `split=16`,
  `max-connection-per-server=16`, `min-split-size=1M`, `dir=downloads/`,
  plus dynamic `user-agent` and cookie header.
- `aria2.tellStatus` — poll download progress by GID.
- `aria2.remove` — cancel an active download.
- Auth: `token:{rpc_secret}` as first param.

## R2: yt-dlp Python Module Integration

**Decision**: Import `yt_dlp` directly and call `YoutubeDL.download()` inside a
background task via `asyncio.to_thread()`. This follows the existing `yt_dlp_api.md`
skill pattern.

**Rationale**: Constitution Principle II mandates direct import, no subprocess.
Running in a thread prevents blocking the async event loop while yt-dlp does
synchronous I/O. yt-dlp's progress hooks can be used to emit structured events.

**Alternatives considered**:
- `subprocess.run(["yt-dlp", ...])`: Violates constitution. Rejected.
- Native async wrapper: yt-dlp has no async API; wrapping in `to_thread` is the
  standard approach.

**Key Options**:
```python
ydl_opts = {
    'format': 'bestvideo+bestaudio/best',
    'outtmpl': 'downloads/%(title).200s.%(ext)s',  # 200-char truncation
    'merge_output_format': 'mp4',
    'quiet': True,
    'no_warnings': True,
    'http_headers': {'User-Agent': user_agent},
    'cookiefile': cookie_file_path,  # or 'cookies' dict if supported
}
```

## R3: N_m3u8DL-RE Subprocess Execution

**Decision**: Use `subprocess.run()` with explicit argument list (no shell=True).
Capture stdout/stderr for logging. Run in `asyncio.to_thread()` to avoid blocking.

**Rationale**: Constitution Principle III requires subprocess-only execution for
N_m3u8DL-RE. The `widevine_extractor.md` skill provides the reference implementation.

**Alternatives considered**:
- `asyncio.create_subprocess_exec`: More native to async, but `subprocess.run` in a
  thread is simpler and the existing skill uses `subprocess.run`. Keeping consistency.

**Key Command**:
```
N_m3u8DL-RE <manifest_url> \
  --key <KID:KEY> \
  --save-dir downloads \
  --save-name <output_name> \
  --auto-select \
  --del-after-done
```

## R4: URL Classification / Routing Logic

**Decision**: Deterministic rule-based router with explicit priority order:

1. `drm_keys` present → N_m3u8DL-RE (highest priority)
2. URL ends with `.mpd` → N_m3u8DL-RE
3. URL matches known media site patterns (YouTube, Twitter/X, Vimeo, Dailymotion,
   Twitch, TikTok, Instagram, etc.) → yt-dlp
4. URL ends with `.m3u8` (no drm_keys) → yt-dlp
5. Everything else → aria2

**Rationale**: Constitution Principle II requires deterministic, testable routing.
A simple function with pattern matching is the most testable approach. The known-sites
list can be maintained as a set of domain patterns.

**Alternatives considered**:
- yt-dlp's `extract_info(download=False)` for auto-detection: Too slow (HTTP round-trip
  per URL), non-deterministic (depends on yt-dlp extractors), would block the router.
- Plugin-based routing: Violates Constitution VII (YAGNI/Simplicity).

## R5: Job State Management

**Decision**: In-memory `dict[str, DownloadJob]` protected by `asyncio.Lock`.
Job IDs are UUID4 strings. State machine: `queued → downloading → completed | failed`.

**Rationale**: Constitution VII (Simplicity). A database is unnecessary for v1 —
the daemon is single-process, single-host. Jobs are ephemeral; restart clears history.
If persistence is needed later, a SQLite upgrade is straightforward.

**Alternatives considered**:
- SQLite: Adds persistence but increases complexity. Deferred to v2.
- Redis: Adds an external dependency. Rejected per constitution.

## R6: Structured Logging

**Decision**: Python `logging` module with a custom JSON formatter writing to
`logs/uhdd.log`. Correlation via `download_id` field on every log entry.
Sensitive fields (tokens, keys) redacted by a filter.

**Rationale**: Constitution Principle V mandates JSON structured logs with correlation IDs.
Python's built-in logging is sufficient — no external dependency needed.

**Key log events**: `download.queued`, `download.started`, `download.progress`,
`download.completed`, `download.failed`, `engine.health_check`, `api.request`.

## R7: Async Execution Strategy

**Decision**: Use `asyncio.create_task()` to spawn download jobs as fire-and-forget
coroutines. Each coroutine wraps the synchronous engine call in `asyncio.to_thread()`
to avoid blocking the event loop. API endpoints return immediately with `{"status": "queued"}`.

**Rationale**: FastAPI runs on uvicorn's async event loop. All three engines do blocking I/O
(HTTP requests, subprocess, file I/O). `to_thread` is the standard pattern for wrapping sync
code in async FastAPI. `create_task` (not `BackgroundTasks`) gives us a task handle we can
use for cancellation if needed later.

**Alternatives considered**:
- `BackgroundTasks`: Simpler but no task handle for cancellation/monitoring.
  `create_task` is only marginally more complex and strictly more capable.
- Celery + Redis: Massive overkill for single-host daemon. Rejected per constitution.

## R8: Configuration Management

**Decision**: Use pydantic `BaseSettings` for configuration. Reads from environment
variables with fallback to a `.env` file. Sensitive values (aria2 RPC secret) via
env vars only.

**Rationale**: Constitution specifies env vars for secrets and config files for
non-sensitive settings. Pydantic BaseSettings handles both patterns natively with
zero additional dependencies (pydantic is already required by FastAPI).

**Key settings**:
- `ARIA2_RPC_URL` (default: `http://localhost:6800/jsonrpc`)
- `ARIA2_RPC_SECRET` (default: empty string)
- `DOWNLOAD_DIR` (default: `downloads`)
- `LOG_DIR` (default: `logs`)
- `LOG_LEVEL` (default: `INFO`)
