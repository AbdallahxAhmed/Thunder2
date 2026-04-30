# Dark Downloader (UHDD)

Unified Headless Download Daemon + MV3 Chrome Extension that intercepts browser downloads, extracts DRM metadata, and dispatches downloads to specialized engines (aria2, yt-dlp, N_m3u8DL-RE).

## Table of Contents
- [Architecture](#architecture)
- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Routing Rules](#routing-rules)
- [Engines](#engines)
- [Extension Workflows](#extension-workflows)
- [Logging](#logging)
- [Troubleshooting](#troubleshooting)
- [Development Progress](#development-progress)
- [Development](#development)
- [Responsible Use](#responsible-use)

## Architecture
```
Browser (MV3 Extension)
 ├─ EME & Network Hooks (PSSH + License URL/Headers + Manifest)
 ├─ Download Hijacker (chrome.downloads → aria2)
 ├─ Floating UI + Popup (format selection)
 └─ Service Worker (background.js) → UHDD API

UHDD Daemon (FastAPI @ localhost:8000)
 ├─ Router (classify URL → engine)
 ├─ Job Manager (in-memory state)
 ├─ Engine Registry
 ├─ Health Checks
 └─ JSON Logging
```

## Features
- **DRM License Proxy**: Captures PSSH + License URL + headers and negotiates keys server-side via `pywidevine`.
- **Native Download Hijacker**: Cancels Chrome native downloads and routes to `aria2` for multi-connection acceleration.
- **Quality Picker**: Popup and floating UI to select yt-dlp formats.
- **Hybrid Floating UI**: In-page button with format dropdown and RAW stream option when a manifest is intercepted.
- **Health Endpoint**: Reports engine availability at runtime.
- **Structured JSON Logs**: Redacted secrets with request correlation IDs.

## Requirements
### Runtime
- Python 3.x
- Google Chrome 102+ (Manifest V3)
- Binaries available on PATH:
  - `aria2c` (RPC enabled)
  - `N_m3u8DL-RE`
  - `ffmpeg`

### Python Dependencies
Installed via `requirements.txt`:
- fastapi, uvicorn, requests
- yt-dlp, pydantic, pydantic-settings
- pywidevine (for DRM negotiation)

## Quick Start
### 1) Install Python deps
```bash
pip install -r requirements.txt
```

### 2) (Optional) Create `.env`
```env
ARIA2_RPC_URL=http://localhost:6800/jsonrpc
ARIA2_RPC_SECRET=
DOWNLOAD_DIR=downloads
LOG_DIR=logs
LOG_LEVEL=INFO
HOST=0.0.0.0
PORT=8000
WVD_PATH=/path/to/device.wvd
```

### 3) Start aria2 with RPC
Example command:
```bash
aria2c --enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 --rpc-secret=YOUR_SECRET
```

### 4) Start the daemon
```bash
uvicorn src.main:app --host 0.0.0.0 --port 8000
```

### 5) Load the extension
1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select `extension/`

## Configuration
Environment variables (from `.env` or environment):

| Variable | Purpose | Default |
|---|---|---|
| `ARIA2_RPC_URL` | aria2 JSON-RPC endpoint | `http://localhost:6800/jsonrpc` |
| `ARIA2_RPC_SECRET` | aria2 RPC secret token | empty |
| `DOWNLOAD_DIR` | output directory | `downloads` |
| `LOG_DIR` | log directory | `logs` |
| `LOG_LEVEL` | logging level | `INFO` |
| `HOST` | API bind host | `0.0.0.0` |
| `PORT` | API bind port | `8000` |
| `WVD_PATH` | path to Widevine device (.wvd) | empty |

## API Reference
Base URL: `http://localhost:8000`

### `POST /api/download`
Accepts a download request and dispatches to the correct engine.

**Request JSON**
```json
{
  "url": "https://example.com/video",
  "cookies": "a=b; c=d",
  "user_agent": "Mozilla/5.0 ...",
  "drm_keys": "KID:KEY,KID2:KEY2",
  "pssh": "BASE64_PSSH",
  "license_url": "https://license.example.com",
  "license_headers": { "Authorization": "Bearer ..." },
  "drm_hint": true,
  "title": "Optional title",
  "referer": "https://origin.example.com",
  "engine": "aria2 | ytdlp | m3u8",
  "format_id": "bestvideo[height<=1080]+bestaudio/best"
}
```

**Response (202)**
```json
{ "id": "uuid", "status": "queued", "engine": "ytdlp", "message": "Download request accepted" }
```

### `GET /api/download/{id}`
Returns status for a download job.

**Response**
```json
{
  "id": "uuid",
  "url": "https://example.com/video",
  "engine": "ytdlp",
  "status": "downloading",
  "progress": 52.3,
  "speed": "3.4 MB/s",
  "output_path": "downloads/file.mp4",
  "file_size": 123456789,
  "error": null,
  "created_at": "2026-04-30T00:00:00Z",
  "updated_at": "2026-04-30T00:01:00Z"
}
```

### `GET /api/info?url=...`
Returns a curated list of quality tiers for popup/floating UI.

Optional query params:
- `drm_hint=true` to indicate a DRM/manifest signal was detected client-side. When yt-dlp fails, the response will include `suggested_engine: "m3u8"` for UI fallback.

**Response**
```json
{
  "url": "https://example.com/watch?v=123",
  "title": "Video Title",
  "thumbnail": "https://...",
  "duration": 1234,
  "max_height": 1080,
  "status": "ok",
  "suggested_engine": null,
  "reason": null,
  "options": [
    { "label": "Best Quality (1080p)", "format_id": "bestvideo+bestaudio/best", "type": "video", "badge": "HD" },
    { "label": "720p", "format_id": "bestvideo[height<=720]+bestaudio/best", "type": "video", "badge": "HD" },
    { "label": "Audio Only (best)", "format_id": "bestaudio/best", "type": "audio", "badge": null }
  ]
}
```

### `GET /api/health`
Reports availability of aria2, yt-dlp, and N_m3u8DL-RE.

**Response**
```json
{
  "status": "healthy",
  "uptime_seconds": 123.4,
  "engines": [
    { "name": "aria2", "available": true, "version": "1.36.0" },
    { "name": "ytdlp", "available": true, "version": "2024.01.01" },
    { "name": "m3u8", "available": false, "error": "N_m3u8DL-RE binary not found on PATH" }
  ]
}
```

### Error Format
All errors are structured:
```json
{
  "error_code": "VALIDATION_ERROR",
  "message": "Request validation failed",
  "details": [{ "field": "url", "message": "URL must start with http:// or https://" }]
}
```

## Routing Rules
Requests are routed in priority order:
1. `drm_keys` present → **m3u8**
2. `pssh` + `license_url` present → **m3u8**
3. `drm_hint` present → **m3u8**
4. URL ends with `.mpd` → **m3u8**
5. Domain is known media site → **ytdlp**
6. URL ends with `.m3u8` → **ytdlp**
7. Everything else → **aria2**

If `engine` is explicitly provided, it overrides routing.

## Engines
### aria2
- JSON‑RPC client
- 16 connections per download
- Forwards `user_agent`, `cookies`, and `referer`

### yt-dlp
- Uses Python `yt_dlp` module
- Supports `format_id` overrides from UI
- Muxes into MP4 when possible

### N_m3u8DL-RE + pywidevine
- Handles DRM HLS/DASH downloads
- Uses `--key` for every KID:KEY pair
- Can negotiate keys via `pywidevine` when `pssh` + `license_url` are provided

## Extension Workflows
### DRM License Proxy
1. `eme_hook.js` captures PSSH (EME), manifest URL, and license requests (fetch/XHR, including `Request` objects).
2. `bridge.js` forwards captured data to the service worker.
3. `background.js` stores the DRM package until the user triggers a RAW download.
4. Daemon negotiates keys via `pywidevine` and invokes `N_m3u8DL-RE`.

### Native Download Hijacker
1. `chrome.downloads.onCreated` fires.
2. Extension gathers URL, referer, user agent, and cookies.
3. Sends payload to `/api/download` with `engine: "aria2"`.
4. Cancels the native download only after successful dispatch.

### Quality Picker (Popup)
1. Popup checks the current tab’s domain.
2. Requests `/api/info` via the background service worker.
3. User selects a format → daemon receives `format_id`.

### Floating UI
- Injected via `content.js` into frames with a `<video>` element.
- UI lives in a closed Shadow DOM.
- Uses background service worker for all daemon communication to bypass CSP.

### Format Cache
`background.js` caches format results per tab and serves them to both the popup and floating UI. Prefetch hooks are present but disabled by default.

## Logging
- JSON logs written to `logs/uhdd.log`
- Automatic redaction of sensitive values
- Correlation IDs added per request (`X-Request-ID`)

## Troubleshooting
| Symptom | Likely Cause | Fix |
|---|---|---|
| `ENGINE_UNAVAILABLE` | Engine not installed or not running | Check `/api/health` and install missing binaries |
| aria2 RPC unreachable | aria2 not running or wrong URL | Start aria2 with RPC, verify `ARIA2_RPC_URL` |
| DRM download fails | Missing/invalid `.wvd` or license headers | Set `WVD_PATH`, verify captured headers |
| Popup shows "Backend offline" | Daemon not running | Start `uvicorn src.main:app` |
| Cookies missing in hijacked downloads | Cookie access denied | Downloads still proceed without cookies |

## Development Progress
### Backend (UHDD Daemon)
- ✅ FastAPI app with lifespan startup (logging, runtime dirs, engine registration, initial health check)
- ✅ Core endpoints: `/api/download`, `/api/download/{id}`, `/api/info`, `/api/health` + structured error responses
- ✅ Deterministic routing: DRM keys or `.mpd` → `m3u8`, known media domains or `.m3u8` → `ytdlp`, default → `aria2`
- ✅ Engine integrations: aria2 JSON-RPC polling, yt-dlp module, N_m3u8DL-RE + Widevine CDM negotiation
- ✅ JSON logging with redaction + `X-Request-ID` correlation IDs
- ⏳ Spec tasks still open in `specs/001-uhdd-download-daemon/tasks.md`: T039 (full pytest + coverage), T040 (quickstart validation)

### Extension (MV3)
- ✅ DRM interception pipeline + license proxy buffering (EME/PSSH + license headers) with explicit user-triggered dispatch
- ✅ Native download hijacking → aria2 with anti-loop guard and metadata forwarding
- ✅ Quality Picker popup (format discovery via `/api/info` + dispatch)
- ✅ Floating UI (hybrid RAW + parsed formats menu, draggable overlay, background proxy)
- ⚠️ Format prefetch exists but is not wired: `prefetchFormats()` is implemented yet its triggers in `tabs.onUpdated` and `tabs.onActivated` are commented out.

### Current Problems / Open Items
- Floating UI needs IDM-like auto-placement: anchor to the detected `<video>` element and track it on resize/scroll, while still allowing manual drag. Current behavior starts top-right and relies on user drag.
- Spec status drift: several spec docs are still marked Draft or have unchecked tasks despite matching code being present (e.g., MV3 tasks T007/T008/T009/T014). Align spec status + checklists to actual implementation.

## Development
### Step-by-step local dev
1. Install dev dependencies: `pip install -r requirements-dev.txt`
2. Start aria2 RPC (see Quick Start step 3)
3. Start the daemon with reload (see Backend section below)
4. Load/reload the extension (see Extension section below)
5. Run tests (see Tests section below)

### Install dev dependencies
```bash
pip install -r requirements-dev.txt
```

### Backend (UHDD daemon)
- Configuration comes from `.env` or environment variables (`ARIA2_RPC_URL`, `ARIA2_RPC_SECRET`, `DOWNLOAD_DIR`, `LOG_DIR`, `LOG_LEVEL`, `HOST`, `PORT`, `WVD_PATH`).
- Start the API with auto-reload:
```bash
uvicorn src.main:app --reload --host 0.0.0.0 --port 8000
```
- Runtime output:
  - JSON logs: `logs/uhdd.log` (created on startup)
  - Downloads: `downloads/` (created on startup)
- Engine registration:
  - `aria2` is always registered (expects a running aria2 RPC endpoint)
  - `ytdlp` registers only if the `yt_dlp` module is installed
  - `m3u8` registers only if `N_m3u8DL-RE` is on `PATH`
  - Check availability at `GET /api/health`

### Extension (MV3)
- No build step. Source lives in `extension/`:
  - Service worker: `background.js`
  - Content scripts: `content_scripts/eme_hook.js`, `content_scripts/bridge.js`, `content.js`
  - Popup UI: `popup.html` + `popup.js`
- Load unpacked via `chrome://extensions` → **Developer mode** → **Load unpacked** → `extension/`.
- After edits, hit **Reload** on the extension and refresh the target page to re-inject content scripts.
- Service worker logs: click **Service worker** in the extension card.

### Tests
```bash
pytest
```

Optional coverage:
```bash
pytest --cov=src --cov-report=term-missing
```

## Responsible Use
This project is intended for authorized media downloading and testing in environments where you have rights to access and process the content. Respect DRM, licensing, and local laws.
