# Thunder — Universal Headless DRM Downloader

> **Active development — core queue manager implemented. A full IDM-style desktop GUI app (Tauri) is planned as the primary interface.**

Thunder is a full-stack download manager: a high-performance Python/FastAPI backend combined with a Chrome MV3 extension for browser integration, and a planned native desktop GUI (Tauri or equivalent) that will provide an IDM-grade experience — live progress bars, download queue management, history, site rules, and DRM support — all in one app.

The backend is intentionally designed as a headless daemon with a clean REST + WebSocket API so it can be driven by any frontend: the Chrome extension today, the Tauri desktop app tomorrow.

---

## Table of Contents

- [Architecture](#architecture)
- [Core Features](#core-features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Routing Rules](#routing-rules)
- [Engines](#engines)
- [Extension Workflows](#extension-workflows)
- [Logging](#logging)
- [Current State](#current-state)
- [Known Bugs](#known-bugs)
- [Development Roadmap](#development-roadmap)
- [Responsible Use](#responsible-use)

---

## Architecture

The system is designed as a **three-tier pipeline** today, and will grow into a **four-tier stack** once the desktop GUI is added:

```
┌──────────────────────────────────────────────────────────────────┐
│  [Planned] Desktop GUI — Tauri (Rust + WebView)                  │
│                                                                  │
│  IDM-style download manager window:                              │
│  • Download queue with live progress bars (speed, ETA, %)       │
│  • Add URL / drag-and-drop downloads                             │
│  • DRM key entry, site rules, per-site cookies                   │
│  • Download history & file browser                               │
│  • Settings panel (concurrency, directories, engine config)      │
│  • System tray + notifications                                   │
│                                                                  │
│  Communicates with daemon via REST + WebSocket                   │
└──────────────────────────────────────────────┬───────────────────┘
                                               │ REST + WS
┌──────────────────────────────────────────────┴───────────────────┐
│                   Chrome Extension (MV3)                         │
│  (Browser integration layer — captures DRM data, pills on video) │
└──────────────────────────────────────────────┬───────────────────┘
                                               │
                               HTTP POST /api/download
                               WS   ws://localhost:8000/api/ws/events
                                               │
┌──────────────────────────────────────────────▼───────────────────┐
│               Thunder Daemon (FastAPI @ :8000)                   │
│                                                                  │
│  ┌──────────┐  ┌───────────────────────┐  ┌─────────────┐       │
│  │  Router  │  │    Queue Manager      │  │  Event Bus  │       │
│  │          │  │  (SQLite + Hot Cache) │  │ (WebSocket) │       │
│  │ Classify │  │                       │  │             │       │
│  │ URL →    │──│ • Persistent jobs     │──│ • Real-time │       │
│  │ Engine   │  │ • Concurrency limits  │  │   push to   │       │
│  └──────────┘  │ • Scheduler loop      │  │   all GUIs  │       │
│                │ • Pause/Resume/Cancel │  └─────────────┘       │
│                │ • Groups (playlists)  │                         │
│                └───────────┬───────────┘                         │
│                            │                                     │
│                  ┌─────────▼──────────────┐                      │
│                  │    Engine Registry     │                      │
│                  │  aria2 / yt-dlp / m3u8 │                      │
│                  └────────────────────────┘                      │
└──────────────────────────────────────────────────────────────────┘
```

> **Backend design note:** The daemon is intentionally framework-agnostic. The REST + WebSocket API it exposes is the single contract that both the Chrome extension and the future Tauri GUI consume. No GUI logic lives in the backend — this keeps the daemon portable and ensures both frontends stay in sync automatically via the shared WebSocket event bus.

### Data Flow (Current — Chrome Extension)

1. **EME Hook** (`eme_hook.js`, MAIN world) intercepts `navigator.requestMediaKeySystemAccess` and `MediaKeySession` to capture PSSH init data, license server URLs, and authentication headers.
2. **Key Ripping** — Hooks `MediaKeySession.prototype.update` to extract `KID:KEY` pairs directly from the browser's EME session (ClearKey format), bypassing server-side CDM negotiation entirely.
3. **Bridge** (`bridge.js`, ISOLATED world) relays captured DRM metadata from the MAIN world to the Service Worker via `chrome.runtime.sendMessage`.
4. **Background** (`background.js`) stores metadata in per-tab buffers and proxies the download request to the FastAPI daemon. Also maintains a WebSocket connection to the daemon's event bus to relay real-time job updates back to content scripts.
5. **Backend** classifies the URL, creates a persistent job in SQLite via the Queue Manager, and the scheduler promotes it to an engine worker thread respecting global and per-engine concurrency limits.

### Data Flow (Planned — Tauri Desktop GUI)

1. User pastes a URL or adds a file in the desktop app.
2. App sends `POST /api/download` (with optional DRM keys/cookies captured by the extension or entered manually).
3. Daemon creates a job and the scheduler runs the download in the background.
4. Desktop app receives real-time progress via the WebSocket event bus (`/api/ws/events`) and renders live progress bars, speed, and ETA.
5. On completion, the app shows a system notification and updates the download history panel.

---

## Core Features

### Persistent Queue Manager
The daemon now uses a SQLite-backed Queue Manager (`src/queue_manager.py`) that replaces the old in-memory job tracker:
- Jobs persist across daemon restarts (WAL-mode SQLite at `data/thunder.db`)
- Hot Cache keeps volatile progress data in-memory for zero-latency reads
- Startup recovery resets stale `DOWNLOADING` jobs back to `QUEUED` after a crash
- Event-driven scheduler with configurable global and per-engine concurrency limits
- Full 6-state lifecycle: `queued → downloading → completed | failed | paused | cancelled`
- Download groups for playlist/batch downloads

### Auto-Widevine Decryption
Full automated DRM pipeline: PSSH extraction → License URL interception → Header capture → CDM negotiation via `pywidevine` → Key injection into `N_m3u8DL-RE --key KID:KEY`. Supports custom `device.wvd` provisioning.

### EME Key Ripping (VMP Bypass)
When the DRM license server enforces Verified Media Path (VMP) or device blacklisting (returning `400 BAD REQUEST` to `pywidevine`), the extension falls back to ripping keys directly from the browser's own EME session. This hooks `MediaKeySession.prototype.update`, parses the license response, and extracts `KID:KEY` hex pairs — completely bypassing server-side CDM negotiation.

### CDN Anti-Hotlinking Bypass
`N_m3u8DL-RE` subprocess requests are automatically injected with browser-spoofing headers derived from the originating `page_url`:
- `User-Agent`: Chrome 124 on Windows 10
- `Referer`: The full page URL from the browser tab
- `Origin`: Parsed scheme + netloc from `page_url`

This defeats Cloudflare, BunnyCDN, and similar WAF/hotlinking protections that return `403 Forbidden` on naked requests.

### Smart Title Extraction
Multi-layered filename resolution:
1. `<h1>` element text (most specific on course/video platforms)
2. `document.title` with site-suffix stripping
3. URL slug extraction from `page_url` pathname (e.g., `/lessons/43-packages-tar/` → `43 Packages Tar`)
4. UUID detection and rejection — if the save name matches a hex UUID pattern, it's replaced with the URL slug
5. `sender.tab.url` override in `background.js` to defeat iframe-sourced URLs

### IDM-Grade Concurrency
- `N_m3u8DL-RE`: `--thread-count 16` for parallel chunk downloads
- `aria2`: Multi-connection acceleration via RPC with configurable `split` and `max-connection-per-server`
- Queue Manager: configurable global limit (default 8) and per-engine limits (aria2: 4, ytdlp: 3, m3u8: 2)

### Native Download Hijacking
Intercepts Chrome's native download events and reroutes them through `aria2` for multi-connection acceleration, with automatic cookie and referer forwarding.

### Hybrid Floating UI
In-page morphing pill overlay with:
- Glassmorphism design in closed Shadow DOM (zero CSS conflicts)
- Pure JS drag-and-drop with Euclidean click detection
- Predictive format pre-warming on video detection
- Size-adaptive scaling relative to video element dimensions
- SPA-aware: tracks navigation and resets state on new video pages

### Real-Time WebSocket Event Bus
The daemon exposes `ws://localhost:8000/api/ws/events`. The background service worker connects on startup and relays events to content scripts. On connect, clients receive a full job snapshot. Subsequent events:
- `job.state_changed` — unthrottled, fired on every state transition
- `job.progress` — throttled to 2 events/sec per job
- `group.created / state_changed / progress / deleted` — group lifecycle events

---

## Requirements

### Runtime
- Python 3.11+
- Google Chrome 102+ (Manifest V3)
- Binaries on PATH:
  - `aria2c` (with RPC enabled)
  - `yt-dlp`
  - `N_m3u8DL-RE`
  - `ffmpeg` / `ffprobe`

### Isolated binaries (recommended)
You can keep all required binaries inside the repo and only add them to `PATH` for the shell that runs the daemon. This keeps installs isolated from the OS.

#### Linux (bash)
```bash
mkdir -p .tools/bin

# aria2c
curl -L https://github.com/aria2/aria2/releases/latest/download/aria2-1.37.0-linux-gnu-x86_64-build1.tar.xz -o /tmp/aria2.tar.xz
tar -xf /tmp/aria2.tar.xz -C /tmp
cp /tmp/aria2-*/bin/aria2c .tools/bin/

# yt-dlp
curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o .tools/bin/yt-dlp

# N_m3u8DL-RE
curl -L https://github.com/nilaoda/N_m3u8DL-RE/releases/latest/download/N_m3u8DL-RE -o .tools/bin/N_m3u8DL-RE

# ffmpeg / ffprobe
curl -L https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-n6.1-latest-linux64-gpl-6.1.tar.xz -o /tmp/ffmpeg.tar.xz
tar -xf /tmp/ffmpeg.tar.xz -C /tmp
cp /tmp/ffmpeg-*/bin/ffmpeg /tmp/ffmpeg-*/bin/ffprobe .tools/bin/

chmod +x .tools/bin/*
export PATH="$PWD/.tools/bin:$PATH"
```
> If you're on ARM or a different distro, use the matching archive from each release page and update the filenames above.

#### Windows (PowerShell)
```powershell
$tools = "$PWD\.tools\bin"
New-Item -ItemType Directory -Force $tools | Out-Null

# aria2c
Invoke-WebRequest https://github.com/aria2/aria2/releases/latest/download/aria2-1.37.0-win-64bit-build1.zip -OutFile "$env:TEMP\aria2.zip"
Expand-Archive "$env:TEMP\aria2.zip" -DestinationPath "$env:TEMP\aria2" -Force
Get-ChildItem "$env:TEMP\aria2\*\aria2c.exe" | Copy-Item -Destination $tools

# yt-dlp
Invoke-WebRequest https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe -OutFile "$tools\yt-dlp.exe"

# N_m3u8DL-RE
Invoke-WebRequest https://github.com/nilaoda/N_m3u8DL-RE/releases/latest/download/N_m3u8DL-RE.exe -OutFile "$tools\N_m3u8DL-RE.exe"

# ffmpeg / ffprobe
Invoke-WebRequest https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-n6.1-latest-win64-gpl-6.1.zip -OutFile "$env:TEMP\ffmpeg.zip"
Expand-Archive "$env:TEMP\ffmpeg.zip" -DestinationPath "$env:TEMP\ffmpeg" -Force
Get-ChildItem "$env:TEMP\ffmpeg\*\bin\ffmpeg.exe" | Copy-Item -Destination $tools
Get-ChildItem "$env:TEMP\ffmpeg\*\bin\ffprobe.exe" | Copy-Item -Destination $tools

$env:Path = "$tools;$env:Path"
```
> If you need ARM or 32-bit builds, swap the archive names for the correct ones from each release page.

### Python Dependencies
```bash
pip install -r requirements.txt
# fastapi, uvicorn, yt-dlp, pydantic, pydantic-settings, pywidevine, aiosqlite, requests
```

### Optional
- `device.wvd` — Widevine CDM device file for automated DRM negotiation (path set via `WVD_PATH` env var)

---

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> thunder
cd thunder
python -m venv .venv
source .venv/bin/activate  # Linux/macOS
# Windows PowerShell: .\.venv\Scripts\Activate.ps1
# Windows CMD:        .\.venv\Scripts\activate.bat
pip install -r requirements.txt

# 2. Start the daemon
uvicorn src.main:app --host 0.0.0.0 --port 8000
# SQLite database is created automatically at data/thunder.db

# 3. Load extension
# Chrome → chrome://extensions → Enable Developer Mode
# → Load Unpacked → Select ./extension/

# 4. Navigate to any video page
# The floating pill appears automatically on detected <video> elements
# Click → Select format → Download dispatches to the backend
```

---

## Configuration

All settings can be overridden via environment variables or a `.env` file in the project root.

| Variable | Default | Description |
|----------|---------|-------------|
| `WVD_PATH` | `""` | Path to Widevine CDM device file (`.wvd`) |
| `DOWNLOAD_DIR` | `downloads` | Output directory for completed downloads |
| `PORT` | `8000` | FastAPI server port |
| `HOST` | `0.0.0.0` | FastAPI server host |
| `ARIA2_RPC_URL` | `http://localhost:6800/jsonrpc` | aria2 RPC endpoint |
| `ARIA2_RPC_SECRET` | `""` | aria2 RPC secret token |
| `LOG_DIR` | `logs` | Directory for structured log files |
| `LOG_LEVEL` | `INFO` | Logging level |
| `DB_PATH` | `data/thunder.db` | SQLite database path for Queue Manager |

Runtime concurrency limits can also be updated live via `PUT /api/settings` without restarting the daemon.

---

## API Reference

### Health & Info

#### `GET /api/health`
Returns engine availability and daemon uptime.

#### `GET /api/info?url=<URL>&drm_hint=<bool>`
Extracts available quality options via yt-dlp. Returns curated resolution tiers with format IDs, file sizes, codecs, and engine hints. Gracefully falls back to `unsupported` status for unrecognised URLs.

#### `POST /api/info`
Same as `GET /api/info` but accepts a JSON body including `cookies` (Chrome cookie objects) and `user_agent` — used by the extension to pass session credentials.

---

### Download

#### `POST /api/download` → `202 Accepted`
Submit a download job. The job is persisted immediately and the scheduler promotes it when a slot is available.

```json
{
  "url": "https://cdn.example.com/manifest.m3u8",
  "drm_keys": "KID_HEX:KEY_HEX",
  "pssh": "base64-encoded-pssh",
  "license_url": "https://drm.example.com/license",
  "license_headers": {"Authorization": "Bearer ..."},
  "page_url": "https://www.example.com/watch/video-title",
  "title": "Video Title",
  "drm_hint": true,
  "engine": "m3u8",
  "format_id": "137+140",
  "cookies": [...],
  "user_agent": "Mozilla/5.0 ..."
}
```

Returns `{ "id": "<job_id>", "status": "queued", "engine": "m3u8" }`.

#### `GET /api/download/{job_id}`
Query the current status of a job. Merges Hot Cache volatile fields (progress, speed, ETA) with persistent data.

---

### Job Management

#### `GET /api/jobs`
Paginated, filterable job list. Query params: `limit`, `offset`, `status`, `engine`, `group_id`.

#### `POST /api/jobs/{id}/pause`
Pause a `downloading` job. Cancels the engine task and frees the concurrency slot.

#### `POST /api/jobs/{id}/resume`
Resume a `paused` job. Transitions to `queued` and wakes the scheduler.

#### `POST /api/jobs/{id}/cancel`
Cancel a `queued` or `downloading` job. Terminal state — cannot be undone.

#### `POST /api/jobs/{id}/retry`
Retry a `failed` job. Increments `retry_count` and transitions back to `queued`.

#### `DELETE /api/jobs/{id}`
Delete a job record from the database.

---

### Groups

#### `POST /api/groups`
Create a download group (playlist/batch). Optionally provide `urls` to immediately create child jobs.

#### `GET /api/groups`
List all groups with aggregate counts (total, completed, failed jobs).

#### `GET /api/groups/{id}`
Get a group with its full job list.

#### `POST /api/groups/{id}/pause` / `POST /api/groups/{id}/resume`
Bulk pause or resume all jobs in a group.

#### `DELETE /api/groups/{id}`
Delete a group. Child jobs are dissociated (not deleted).

---

### Settings

#### `GET /api/settings`
Read all runtime settings (concurrency limits, download directory).

#### `PUT /api/settings`
Update settings live. Changes take effect on the next scheduler cycle.

```json
{
  "settings": {
    "global_max_concurrent": "8",
    "engine_limit_aria2": "4",
    "engine_limit_ytdlp": "3",
    "engine_limit_m3u8": "2"
  }
}
```

---

### Admin

#### `POST /api/admin/clear-queue`
Emergency endpoint: cancel all non-terminal jobs and wipe the active queue.

---

### WebSocket

#### `WS /api/ws/events`
Read-only real-time event stream. On connect, the client receives a `snapshot` event with all active jobs. Subsequent events are pushed as state changes and progress updates occur. Client messages are silently discarded (read-only enforcement).

Event shape:
```json
{ "type": "job.state_changed", "data": { "id": "<job_id>", "status": "completed", ... } }
{ "type": "job.progress",      "data": { "id": "<job_id>", "progress": 72.4, "speed": "4.2 MB/s", "eta": 12 } }
{ "type": "snapshot",          "data": { "jobs": [...] } }
```

---

## Routing Rules

| Priority | Condition | Engine | Notes |
|----------|-----------|--------|-------|
| 1 | `drm_keys` present | `m3u8` | N_m3u8DL-RE with pre-extracted keys |
| 2 | `pssh` + `license_url` present | `m3u8` | CDM negotiation via pywidevine |
| 3 | `drm_hint=true` | `m3u8` | DRM/manifest signal from interceptor |
| 4 | URL ends with `.mpd` | `m3u8` | DASH manifest |
| 5 | URL domain in known media sites | `ytdlp` | YouTube, Vimeo, Dailymotion, Twitter, TikTok, etc. |
| 6 | URL ends with `.m3u8` (no DRM) | `ytdlp` | Plain HLS via yt-dlp |
| 7 | Everything else | `aria2` | Direct file download |

The `engine` field in `POST /api/download` overrides all routing rules.

---

## Engines

### M3U8 Client (`src/engines/m3u8_client.py`)
Orchestrates DRM downloads:
1. **Key Resolution**: Prioritizes pre-extracted `drm_keys` over Pywidevine CDM negotiation
2. **Browser Spoofing**: Injects `User-Agent`, `Referer`, `Origin` from `page_url`
3. **Smart Naming**: UUID detection + URL slug fallback
4. **Subprocess**: `N_m3u8DL-RE` with `--thread-count 16`, `--auto-select`, `-M format=mp4`

### Widevine CDM (`src/engines/widevine_cdm.py`)
Server-side CDM negotiation:
- Loads `device.wvd` → generates challenge → POSTs to license server with spoofed headers → parses keys
- Spoofs `Origin`/`Referer` from `page_url` to pass CORS/WAF validation

### aria2 RPC Client (`src/engines/aria2_client.py`)
Multi-connection direct downloads via JSON-RPC with cookie forwarding.

### yt-dlp Engine (`src/engines/ytdlp_client.py`)
Format extraction and download for supported video platforms. Cookie and User-Agent forwarding supported.

---

## Extension Workflows

### EME Hook Pipeline
```
Page loads → eme_hook.js injects into MAIN world
  → Hooks navigator.requestMediaKeySystemAccess
  → Hooks MediaKeySession.generateRequest (captures PSSH)
  → Hooks MediaKeySession.update (attempts key ripping)
  → Intercepts fetch/XHR (captures license URL + headers)
  → Strict binary filter: only ArrayBuffer/Uint8Array bodies
  → Dispatches "thunder_payload_ready" CustomEvent
  → bridge.js relays to background.js
  → Stored in tabBuffers[tabId]
```

### Download Trigger
```
User clicks pill → Menu opens → Format selected
  → content.js sends TRIGGER_DOWNLOAD
  → background.js enriches payload from tabBuffers
  → Forces page_url = sender.tab.url (iframe override)
  → POST /api/download to daemon
  → Queue Manager creates job in SQLite
  → Scheduler promotes job when slot available
  → Engine executes download
  → WebSocket pushes progress/completion back to extension
```

### Real-Time Progress Flow
```
Daemon engine reports progress
  → QueueManager.update_job() called
  → EventBus.emit_progress() fires (throttled 2/sec/job)
  → WebSocket broadcast to all clients
  → background.js receives WS_EVENT
  → Relays to all content scripts via chrome.tabs.sendMessage
  → content.js updates pill UI (progress display not yet implemented)
```

---

## Logging

Structured JSON logs with correlation IDs:
```json
{
  "timestamp": "2026-05-03T12:00:00Z",
  "level": "INFO",
  "logger": "src.engines.m3u8_client",
  "message": "N_m3u8DL-RE completed: job-id → /path/to/file.mp4",
  "correlation_id": "uuid",
  "event": "download.completed"
}
```

Sensitive data (Authorization headers, DRM keys) are redacted in production logs. Log files are written to the `logs/` directory.

---

## Current State

| Component | Status | Notes |
|-----------|--------|-------|
| DRM Pipeline (PSSH + License + Keys) | ✅ Stable | |
| EME Key Ripping (VMP Bypass) | ✅ Stable | |
| CDN Anti-Hotlinking (Referer/UA Spoof) | ✅ Stable | |
| Smart Title Extraction (iframe override) | ✅ Stable | |
| Floating Pill UI (Shadow DOM) | ✅ Stable | |
| Download Hijacking (aria2) | ✅ Stable | |
| YouTube Format Extraction & Download | ✅ Stable | Age-gated content works |
| N_m3u8DL-RE Integration (16 threads) | ✅ Stable | |
| Structured JSON Logging | ✅ Stable | |
| SQLite Queue Manager (persistence) | ✅ Implemented | Survives restarts |
| Concurrency Scheduler (global + per-engine) | ✅ Implemented | |
| Pause / Resume / Cancel / Retry | ✅ Implemented | |
| Download Groups (playlists/batches) | ✅ Implemented | |
| REST API (jobs, groups, settings) | ✅ Implemented | |
| WebSocket Event Bus | ✅ Implemented | Real-time push to extension |
| Startup Crash Recovery | ✅ Implemented | Stale jobs reset to QUEUED |
| Integration Tests (API + Queue) | ⚠️ Partial | Unit tests pass; API integration tests pending |
| Progress UI in Pill (%, speed, ETA) | ❌ Not yet | Extension receives WS events but pill has no progress display |
| Dailymotion Downloads | ❌ Broken | See Known Bugs |
| CloudNative / Generic M3U8 Downloads | ❌ Broken | See Known Bugs |

---

## Known Bugs

| Area | Severity | Description |
|------|----------|-------------|
| YouTube quality labels | Low | Unusual resolutions (e.g. `2026p`) are displayed as-is instead of being rounded to the nearest standard tier |
| Dailymotion format picker | High | Quality options are not displayed — yt-dlp YouTube settings appear to leak into Dailymotion requests, causing empty format lists |
| CloudNative / Generic M3U8 | High | Downloads fail with HTTP 403 or N_m3u8DL-RE CLI errors; routing to `m3u8` engine is correct but execution fails |
| SPA job ID reset | Medium | After navigating between videos in SPAs, the pill can retain a stale `jobId` from the previous video. A deeper reset is needed to prevent the new download from inheriting old job state |

---

## Development Roadmap

### ✅ Done — Queue Manager (Spec 007)
- Phases 1–5 complete: SQLite schema, Hot Cache, concurrency scheduler, pause/resume/cancel/retry, groups, REST API, WebSocket event bus
- `src/job_manager.py` (old in-memory tracker) is superseded by `src/queue_manager.py`

### 🚧 In Progress — Integration & Validation (Spec 007, Phase 6)
- [ ] Integration tests for `POST /api/download` and `GET /api/download/{id}` via QueueManager
- [ ] Integration tests for `GET /api/info` and `GET /api/health` remain unchanged
- [ ] Remove deprecated `src/job_manager.py` once all references are confirmed clean
- [ ] Validate full Chrome extension flow on the new Queue Manager backend

### ⏳ Pending — Frontend Progress UI
- [ ] Live progress display (%, speed, ETA) inside the floating pill
- [ ] Download history panel
- [ ] Toast notifications on completion/failure
- [ ] The infrastructure (WebSocket event bus + `background.js` relay) is already in place — only the `content.js` rendering layer is missing

### ⏳ Pending — Bug Fixes
- [ ] Fix Dailymotion format extraction (isolate YouTube-specific yt-dlp flags)
- [ ] Fix CloudNative/generic M3U8 403 errors (header spoofing audit in `m3u8_client.py`)
- [ ] Implement YouTube resolution rounding (2026p → 2160p, etc.)
- [ ] Deep SPA job ID reset on video navigation

### ⏳ Pending — Polish
- [ ] Extension settings page (daemon URL, thread count, default quality)
- [ ] Configurable download directory per site
- [ ] Auto-update mechanism for yt-dlp and N_m3u8DL-RE binaries

---

### 🖥️ Planned — Desktop GUI App (IDM-style, Tauri)

The main long-term goal of the project is a native desktop download manager that looks and feels like IDM but is fully open and DRM-capable. The Thunder daemon is the backend for this app.

**Technology**: [Tauri](https://tauri.app/) (Rust shell + WebView frontend) is the current leading candidate — lightweight binary, native OS integration, cross-platform. Alternatives: Electron, Flutter, or a standalone web UI served by the daemon.

**Planned features:**

- [ ] **Download Queue Window** — IDM-style list with filename, size, progress bar, speed, ETA, status
- [ ] **Add URL dialog** — paste any URL, auto-detect type, optional DRM fields (PSSH, license URL, keys)
- [ ] **Live progress** — driven by the existing `/api/ws/events` WebSocket; no backend changes needed
- [ ] **Download groups / playlists** — create a group from a playlist URL, track overall progress
- [ ] **Pause / Resume / Cancel / Retry** — full lifecycle control via existing REST endpoints
- [ ] **Download history** — searchable, filterable, persistent (SQLite already stores all jobs)
- [ ] **Site rules** — per-domain settings: default engine, quality, cookies, download directory
- [ ] **System tray** — minimize to tray, balloon notifications on completion
- [ ] **Settings page** — concurrency limits, download directory, engine paths, Widevine device
- [ ] **Browser extension pairing** — extension sends downloads directly to the running desktop app
- [ ] **Dark / light theme** — follows OS theme

**Backend API readiness for the GUI** (what is already done):

| GUI Need | Backend Status |
|----------|----------------|
| Submit download | ✅ `POST /api/download` |
| Live progress stream | ✅ `WS /api/ws/events` |
| Job list + filters | ✅ `GET /api/jobs` |
| Pause / Resume / Cancel / Retry | ✅ `POST /api/jobs/{id}/...` |
| Delete job | ✅ `DELETE /api/jobs/{id}` |
| Download groups | ✅ `POST/GET /api/groups` |
| Settings (concurrency, dir) | ✅ `GET/PUT /api/settings` |
| Engine health | ✅ `GET /api/health` |
| Format/quality picker | ✅ `GET /api/info` |
| Emergency queue clear | ✅ `POST /api/admin/clear-queue` |

The backend is **GUI-ready**. All APIs the desktop app needs are already implemented and stable.

---

## Responsible Use

This tool is designed for downloading content you have legitimate access to. Respect copyright laws, terms of service, and content creators' rights. The DRM capabilities exist solely for personal backup of legally purchased media.
