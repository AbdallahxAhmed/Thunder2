# Research: Quality Picker Popup

**Date**: 2026-04-27
**Feature**: Quality Picker Popup (yt-dlp Integration)

## R1: yt-dlp `extract_info` Format Structure

**Decision**: Use `yt_dlp.YoutubeDL.extract_info(url, download=False)` to retrieve format metadata without downloading.

**Rationale**: This is the canonical way to query formats from yt-dlp. The `download=False` flag ensures no bytes are fetched, making it suitable for a preview/info endpoint.

**Key fields per format dict**:
- `format_id` (str) — unique identifier, e.g., `"137"`, `"140"`
- `ext` (str) — file extension, e.g., `"mp4"`, `"webm"`, `"m4a"`
- `resolution` (str) — e.g., `"1920x1080"`, `"audio only"`
- `height` (int|None) — pixel height, e.g., `1080`
- `width` (int|None) — pixel width, e.g., `1920`
- `vcodec` (str) — video codec, e.g., `"avc1.640028"`, `"none"` for audio-only
- `acodec` (str) — audio codec, e.g., `"mp4a.40.2"`, `"none"` for video-only
- `filesize` (int|None) — exact file size in bytes (may be None)
- `filesize_approx` (int|None) — estimated file size (fallback)
- `format_note` (str) — human-readable note, e.g., `"1080p"`, `"medium"`
- `fps` (float|None) — frames per second
- `tbr` (float|None) — total bitrate in kbps

**Classification logic**:
- `vcodec != "none"` and `acodec == "none"` → video-only
- `vcodec == "none"` and `acodec != "none"` → audio-only
- Both present → video+audio (combined format)
- Video-only and video+audio are grouped as "video formats"
- Audio-only is grouped as "audio formats"

**Alternatives considered**:
- Subprocess `yt-dlp -F` → Rejected: violates constitution (II. Smart Routing — must import as module)
- Cache format results in daemon → Rejected: YAGNI — popup opens are infrequent, caching adds complexity

---

## R2: Chrome Extension Popup Lifecycle

**Decision**: Use `chrome.action` API (MV3) with `default_popup` in manifest.

**Rationale**: MV3 replaces `browser_action` with `action`. The popup HTML is loaded fresh each time the icon is clicked, and destroyed when it closes.

**Key behaviors**:
- Popup opens → `popup.html` loaded, `popup.js` executes
- Popup closes → all state destroyed (no persistence needed)
- `chrome.tabs.query({ active: true, currentWindow: true })` → returns the active tab
- Popup has access to `fetch()` for daemon communication
- Popup cannot access service worker variables directly (separate context)

**Alternatives considered**:
- Side panel API → Rejected: requires Chrome 114+, not widely available
- New tab page → Rejected: too heavy for a quick format picker

---

## R3: Format Display Strategy

**Decision**: Show top formats grouped by type (video, audio), sorted by quality descending.

**Rationale**: Users want the highest quality options first. Grouping prevents confusion between video and audio-only formats.

**Display rules**:
- Video formats: sorted by `height` descending, then `tbr` descending
- Audio formats: sorted by `tbr` descending (higher bitrate = better quality)
- Show max ~15 video formats and ~5 audio formats to prevent list overload
- Each format button shows: resolution (or "Audio"), codec shortname, file size if known
- File size display: human-readable (MB/GB) using `filesize || filesize_approx`

**Alternatives considered**:
- Show all formats unfiltered → Rejected: YouTube alone returns 30-50 formats, overwhelming
- Single "best" button → Rejected: defeats the purpose of the quality picker

---

## R4: Popup ↔ Daemon Communication

**Decision**: Direct `fetch()` from popup.js to `localhost:8000`.

**Rationale**: The popup runs in the extension context and has access to `fetch()`. Since `host_permissions` already includes `http://localhost:8000/*`, no additional CORS or permission changes are needed.

**Flow**:
1. `GET /api/info?url=<encoded_url>` → returns format list
2. `POST /api/download` → dispatches the download (existing endpoint)

**Error handling**:
- Network error (daemon offline) → show "Backend Offline" state
- HTTP 422 (invalid URL) → show "Unsupported URL" message
- HTTP 500 → show generic error message
- Timeout (30s) → show "Request timed out" message

**Alternatives considered**:
- Route through service worker → Rejected: unnecessary indirection; popup can fetch directly
