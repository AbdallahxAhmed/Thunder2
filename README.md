# Dark Downloader (UHDD) — Unified Headless Download Daemon

> **v3.14.4** — Production-stable DRM decryption, CDN bypass, and intelligent naming pipeline.

A high-performance, browser-integrated download system that intercepts, decrypts, and downloads protected media streams. Combines a Chrome Manifest V3 extension with a Python FastAPI backend and specialized download engines to achieve IDM-grade download performance with full DRM support.

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
- [Current State (v3.14.4)](#current-state-v3144)
- [Development Roadmap](#development-roadmap)
- [Responsible Use](#responsible-use)

---

## Architecture

The system operates as a three-tier hybrid pipeline:

```
┌─────────────────────────────────────────────────────────────┐
│                   Chrome Extension (MV3)                    │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │  eme_hook.js │  │  content.js  │  │  background.js     │ │
│  │  (MAIN world)│  │  (ISOLATED)  │  │  (Service Worker)  │ │
│  │             │  │             │  │                    │ │
│  │ • EME Key   │  │ • Floating  │  │ • Tab Buffers      │ │
│  │   Ripping   │──│   Pill UI   │──│ • Format Cache     │ │
│  │ • PSSH      │  │ • Title     │  │ • Daemon Proxy     │ │
│  │   Capture   │  │   Extract   │  │ • Download Hijack  │ │
│  │ • License   │  │ • Drag/Drop │  │                    │ │
│  │   Intercept │  │             │  │                    │ │
│  └─────────────┘  └──────────────┘  └────────┬───────────┘ │
│                                               │             │
│  bridge.js (ISOLATED) — Event relay           │             │
│  MAIN world ──CustomEvent──► ISOLATED ──chrome.runtime──►   │
└───────────────────────────────────────────────┼─────────────┘
                                                │
                                    HTTP POST /api/download
                                                │
┌───────────────────────────────────────────────▼─────────────┐
│               UHDD Daemon (FastAPI @ :8000)                  │
│                                                             │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────────┐ │
│  │  Router  │  │ Job Manager  │  │   Engine Registry      │ │
│  │          │  │ (in-memory)  │  │                        │ │
│  │ Classify │  │ Create/Track │  │ ┌──────────────────┐   │ │
│  │ URL →    │──│ async jobs   │──│ │ M3U8 Client      │   │ │
│  │ Engine   │  │              │  │ │ • WidevineCDM    │   │ │
│  └──────────┘  └──────────────┘  │ │ • N_m3u8DL-RE   │   │ │
│                                  │ │ • Key Resolution │   │ │
│  ┌──────────┐                    │ ├──────────────────┤   │ │
│  │ Health   │                    │ │ aria2 RPC Client │   │ │
│  │ Checks   │                    │ │ • Multi-conn DL  │   │ │
│  └──────────┘                    │ ├──────────────────┤   │ │
│                                  │ │ yt-dlp Engine    │   │ │
│  ┌──────────┐                    │ │ • Format extract │   │ │
│  │ Struct.  │                    │ └──────────────────┘   │ │
│  │ Logging  │                    └────────────────────────┘ │
│  └──────────┘                                               │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow (DRM-Protected Stream)

1. **EME Hook** (`eme_hook.js`, MAIN world) intercepts `navigator.requestMediaKeySystemAccess` and `MediaKeySession` to capture PSSH init data, license server URLs, and authentication headers.
2. **Key Ripping** — Hooks `MediaKeySession.prototype.update` to extract `KID:KEY` pairs directly from the browser's EME session (ClearKey format), bypassing server-side CDM negotiation entirely.
3. **Bridge** (`bridge.js`, ISOLATED world) relays captured DRM metadata from the MAIN world to the Service Worker via `chrome.runtime.sendMessage`.
4. **Background** (`background.js`) stores metadata in per-tab buffers and proxies the download request to the FastAPI daemon.
5. **Backend** resolves decryption keys (pre-extracted or Pywidevine fallback), constructs the `N_m3u8DL-RE` subprocess with spoofed browser headers, and executes the download.

---

## Core Features

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

### Native Download Hijacking
Intercepts Chrome's native download events and reroutes them through `aria2` for multi-connection acceleration, with automatic cookie and referer forwarding.

### Hybrid Floating UI
In-page morphing pill overlay with:
- Glassmorphism design in closed Shadow DOM (zero CSS conflicts)
- Pure JS drag-and-drop with Euclidean click detection
- Predictive format pre-warming on video detection
- Size-adaptive scaling relative to video element dimensions

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

### Python Dependencies
```bash
pip install fastapi uvicorn httpx pywidevine pydantic requests
```

### Optional
- `device.wvd` — Widevine CDM device file for automated DRM negotiation (placed in project root, referenced via `WVD_PATH`)

---

## Quick Start

```bash
# 1. Clone and install
git clone <repo-url> dark-downloader
cd dark-downloader
pip install -r requirements.txt

# 2. Start the daemon
uvicorn src.main:app --host 0.0.0.0 --port 8000

# 3. Load extension
# Chrome → chrome://extensions → Enable Developer Mode
# → Load Unpacked → Select ./extension/

# 4. Navigate to any video page
# The floating pill appears automatically on detected <video> elements
# Click → Select format → Download dispatches to the backend
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `WVD_PATH` | `./device.wvd` | Path to Widevine CDM device file |
| `DOWNLOAD_DIR` | `./downloads` | Output directory for completed downloads |
| `DAEMON_PORT` | `8000` | FastAPI server port |
| `ARIA2_RPC_URL` | `http://localhost:6800/jsonrpc` | aria2 RPC endpoint |

---

## API Reference

### `GET /api/health`
Returns engine availability status.

### `GET /api/info?url=<URL>&drm_hint=<bool>`
Extracts available formats via yt-dlp. Returns `200 OK` with empty formats for unsupported URLs (graceful fallback).

### `POST /api/download`
Dispatches a download job. Accepts JSON body:
```json
{
  "url": "https://cdn.example.com/manifest.m3u8",
  "drm_keys": "KID_HEX:KEY_HEX",
  "pssh": "base64-encoded-pssh",
  "license_url": "https://drm.example.com/license",
  "license_headers": {"Authorization": "Bearer ..."},
  "page_url": "https://www.example.com/watch/video-title",
  "title": "Video Title",
  "drm_hint": true
}
```

### `GET /api/status/<job_id>`
Returns job status and progress.

---

## Routing Rules

| Pattern | Engine | Notes |
|---------|--------|-------|
| `.m3u8` / `.mpd` / `drm_hint=true` | `m3u8` | DRM-capable, uses N_m3u8DL-RE |
| YouTube / Dailymotion / supported sites | `ytdlp` | Format extraction + download |
| Direct file URLs | `aria2` | Multi-connection acceleration |

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

### aria2 RPC Client
Multi-connection direct downloads via JSON-RPC with cookie forwarding.

### yt-dlp Engine
Format extraction and download for supported video platforms.

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
  → Dispatches "uhdd_payload_ready" CustomEvent
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
  → Backend resolves keys → N_m3u8DL-RE subprocess
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

Sensitive data (Authorization headers, DRM keys) are redacted in production logs.

---

## Current State (v3.14.4)

| Component | Status |
|-----------|--------|
| DRM Pipeline (PSSH + License + Keys) | ✅ Stable |
| EME Key Ripping (VMP Bypass) | ✅ Stable |
| CDN Anti-Hotlinking (Referer/UA Spoof) | ✅ Stable |
| Smart Title Extraction (iframe override) | ✅ Stable |
| Floating Pill UI (Shadow DOM) | ✅ Stable |
| Download Hijacking (aria2) | ✅ Stable |
| Format Extraction (yt-dlp) | ✅ Stable |
| N_m3u8DL-RE Integration (16 threads) | ✅ Stable |
| Structured JSON Logging | ✅ Stable |

---

## Development Roadmap

### Phase 1: Job Queue Manager
- [ ] Implement a robust async Job/Queue Manager with configurable concurrency limits
- [ ] Add job scheduling and priority queues
- [ ] Persistent job state (survive daemon restarts)
- [ ] Retry logic with exponential backoff for transient failures

### Phase 2: Frontend Progress UI
- [ ] Real-time download progress via WebSocket or Server-Sent Events (SSE)
- [ ] Progress bars in the floating pill UI (percentage, speed, ETA)
- [ ] Download history panel in the popup
- [ ] Toast notifications for completion/failure

### Phase 3: Pause/Resume
- [ ] Pause/Resume functionality for large file downloads
- [ ] Partial download persistence (range request support)
- [ ] Background download continuation after browser restart

### Phase 4: Polish
- [ ] Batch download support (playlist/course scraping)
- [ ] Configurable download directory per site
- [ ] Extension settings page (daemon URL, thread count, default quality)
- [ ] Auto-update mechanism for yt-dlp and N_m3u8DL-RE binaries

---

## Responsible Use

This tool is designed for downloading content you have legitimate access to. Respect copyright laws, terms of service, and content creators' rights. The DRM capabilities exist solely for personal backup of legally purchased media.
