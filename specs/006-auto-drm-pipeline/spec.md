# Feature Specification: Auto-DRM Pipeline

**Feature Branch**: `006-auto-drm-pipeline`  
**Created**: 2026-05-03  
**Status**: Draft  
**Supersedes**: Manual-only DRM key input requirement (Constitution v1.1.0 Principle III)  
**Depends On**: Spec 005 "IDM Floating Pill" (completed — pill UI + `TRIGGER_DOWNLOAD` pipeline intact), Constitution v1.2.0 (Principle III amendment ratified)  
**Input**: Phase 6 kickoff — connect Floating UI to the DRM pipeline with automated Widevine decryption and smart title extraction.

## Design Context

### Why This Feature Exists

The current system has three gaps between the user clicking "Download" and a DRM-encrypted video appearing on disk:

1. **No title in the download payload.** When the user clicks a format button in the Floating Pill, the `TRIGGER_DOWNLOAD` message carries `url` and `format_id` but no human-readable title. The backend falls back to a hash-based filename like `drm_a3f9c2b1e4d8.mp4`, which is useless.
2. **No DRM metadata in the download payload.** The EME hook (`eme_hook.js`) already captures `pssh`, `license_url`, and `license_headers` into `tabBuffers` via the bridge. But when the user clicks the "RAW" format button, `content.js` sends a bare `TRIGGER_DOWNLOAD` without these fields — `background.js` only attaches them for the legacy auto-dispatch path, not the new user-initiated pill flow.
3. **No automated key extraction.** Even when `pssh` + `license_url` reach the backend, the system already has the `WidevineCDM` class and `device.wvd`. The pipeline is wired but never triggered from the Floating Pill UI because the payload is incomplete (see gap #2).

This spec closes all three gaps to deliver a true end-to-end: **User clicks RAW → extension sends title + DRM metadata → backend negotiates keys → N_m3u8DL-RE downloads and decrypts → clean `.mp4` with a readable filename.**

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Smart Title Extraction (Priority: P1)

A user navigates to a DRM-protected streaming site. They hover over the video, click the download pill, and select the "🎬 Master Stream (Adaptive)" RAW format. The downloaded file is saved with a clean, human-readable filename derived from the page title (e.g., `Attack on Titan S04E28.mp4`), not a hash.

**Why this priority**: Without a clean title, the user gets `drm_a3f9c2b1e4d8.mp4` — an unacceptable UX regression that makes the download manager feel broken. Title is the cheapest fix with the highest user-visible impact.

**Independent Test**: Navigate to any video page. Open the pill menu. Trigger a download (any format). Inspect the `TRIGGER_DOWNLOAD` message in the background script console. Verify the payload contains `title: "sanitized page title"`.

**Acceptance Scenarios**:

1. **Given** a page with `document.title = "Attack on Titan S04E28 - Watch on Crunchyroll"`, **When** the user clicks any format button, **Then** the `TRIGGER_DOWNLOAD` payload includes `title: "Attack on Titan S04E28"` (suffix ` - Watch on Crunchyroll` stripped).
2. **Given** a page with `document.title = "My Video / Special: Edition"`, **When** the title is sanitized, **Then** illegal filesystem characters (`/`, `:`) are removed, producing `"My Video  Special Edition"`, then collapsed whitespace yields `"My Video Special Edition"`.
3. **Given** a page title longer than 200 characters, **When** the title is sanitized, **Then** it is truncated to 200 characters at a clean boundary (no trailing space).
4. **Given** a page with common suffixes like `" - YouTube"`, `" - Dailymotion"`, `" | Prime Video"`, `" - Watch Online"`, **When** the title is sanitized, **Then** these suffixes are removed before any other processing.
5. **Given** a page with `document.title = ""` or `document.title = "   "`, **When** the title is sanitized, **Then** the `title` field is omitted from the payload (null/undefined), and the backend uses its existing hash-based fallback.

---

### User Story 2 — EME Bridge (Payload Enrichment) (Priority: P1)

A user clicks the "RAW" format button on a DRM-protected page. The `TRIGGER_DOWNLOAD` message automatically includes `pssh`, `license_url`, and `license_headers` extracted from the background's `tabBuffers` — the user does not need to manually input any DRM keys.

**Why this priority**: This is the critical bridge between the UI and the backend DRM pipeline. Without it, clicking "RAW" sends a bare URL that will fail on any DRM-protected stream. Co-P1 with US1 because together they complete the payload.

**Independent Test**: Navigate to a DRM-protected streaming page (e.g., a DASH stream with Widevine). Wait for `eme_hook.js` to capture the PSSH and license URL (visible in the background console as `[UHDD SW] DRM package cached`). Click the RAW button. Inspect the `TRIGGER_DOWNLOAD` payload — it should contain `pssh`, `license_url`, and `license_headers`.

**Acceptance Scenarios**:

1. **Given** the `tabBuffers` for the current tab contain `pssh`, `licenseUrl`, and `licenseHeaders`, **When** the user clicks the RAW format button (`format_id === "raw-intercept"`), **Then** `background.js`'s `TRIGGER_DOWNLOAD` handler attaches `pssh`, `license_url`, and `license_headers` from the buffer to the outgoing payload — **this path already exists in background.js** and just needs the content script to trigger it correctly.
2. **Given** the `tabBuffers` for the current tab do NOT contain DRM metadata (non-DRM stream), **When** the user clicks the RAW button, **Then** the payload is sent without `pssh`/`license_url` fields, and the backend treats it as a plain M3U8 download.
3. **Given** the user clicks a non-RAW format button (a yt-dlp format), **When** the download is triggered, **Then** no DRM metadata is attached — the `format_id` is passed directly to the daemon's yt-dlp engine, unchanged from spec 005 behavior.
4. **Given** the `tabBuffers` have `drmHint: true`, **When** the RAW button is clicked, **Then** `drm_hint: true` is included in the payload to ensure the backend routes to the M3U8/DRM engine.
5. **Given** the user also has a sanitized title (US1), **When** the RAW button is clicked, **Then** the payload includes BOTH `title` AND DRM metadata in a single message.

---

### User Story 3 — Auto-Widevine Backend Decryption (Priority: P1)

When the backend receives a download request containing `pssh` and `license_url`, it automatically negotiates Widevine keys using `device.wvd`, extracts the `KID:KEY` pair(s), and appends `--key KID:KEY` to the `N_m3u8DL-RE` command. The downloaded file is decrypted and muxed into a clean `.mp4`.

**Why this priority**: This is the entire point of the feature. Without backend decryption, the enriched payload from US2 is useless — the stream downloads but remains encrypted. All three stories are co-P1 because they form an indivisible pipeline.

**Independent Test**: Send a manual `POST /api/download` request with `url`, `pssh`, `license_url`, and `license_headers` fields. Verify the backend logs show CDM negotiation, key extraction, and the `N_m3u8DL-RE` command includes `--key` flags. Verify the output file is a playable `.mp4`.

**Acceptance Scenarios**:

1. **Given** a download request with `pssh` and `license_url` fields, **When** `device.wvd` exists at the configured `WVD_PATH`, **Then** the `WidevineCDM.negotiate_keys()` method is called, keys are extracted, and each key is appended as `--key KID:KEY` to the `N_m3u8DL-RE` command.
2. **Given** the CDM negotiation returns 2 content keys, **When** `N_m3u8DL-RE` is invoked, **Then** the command includes `--key KID1:KEY1 --key KID2:KEY2` (one `--key` flag per pair).
3. **Given** a download request with `pssh` and `license_url` but NO `device.wvd` file, **When** the backend attempts CDM negotiation, **Then** a `FileNotFoundError` is raised with the message `"WVD_PATH is not configured"`, the download fails gracefully, and the error is returned to the extension.
4. **Given** the CDM negotiation fails (bad PSSH, license server rejects, network error), **When** the error is caught, **Then** the download is marked as `"failed"` with a descriptive error message, and no `N_m3u8DL-RE` subprocess is spawned.
5. **Given** a download request with `pssh`, `license_url`, AND a `title` field, **When** the download completes successfully, **Then** the output file is named `{sanitized_title}.mp4` (not a hash).
6. **Given** a download request with pre-extracted `drm_keys` (legacy path), **When** the backend processes it, **Then** the pre-extracted keys are used directly — CDM negotiation is NOT attempted — preserving backward compatibility.

---

### Edge Cases

- What if `eme_hook.js` captures multiple PSSH boxes (e.g., audio + video KIDs)? → The hook captures the last PSSH. Multi-PSSH support is out of scope for v1.
- What if the license server requires cookies not captured by `eme_hook.js`? → The extension already captures `license_headers` which typically include auth tokens. Cookie passthrough from the browser is a future enhancement.
- What if the page title contains only emoji or non-ASCII characters? → The sanitizer strips illegal filesystem chars but preserves valid Unicode. Emoji filenames are valid on modern filesystems.
- What if `N_m3u8DL-RE` receives valid keys but the stream uses a different encryption scheme? → The download will fail at the subprocess level; the error is captured and returned.
- What if the user rapidly clicks RAW multiple times? → The first click disables all format buttons (existing behavior from spec 005). Subsequent clicks are blocked.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Title Extraction (US1)

- **FR-001**: `content.js` MUST extract `document.title` at the moment the user clicks a format button.
- **FR-002**: `content.js` MUST sanitize the title by: (a) removing common site suffixes (`" - YouTube"`, `" - Dailymotion"`, `" | Prime Video"`, `" - Watch Online"`, `" - Crunchyroll"`, etc.), (b) removing illegal filesystem characters (`/ \ : * ? " < > |`), (c) collapsing whitespace, (d) trimming, (e) truncating to 200 characters.
- **FR-003**: The sanitized title MUST be included as `title` in the `TRIGGER_DOWNLOAD` payload for ALL format types (RAW and yt-dlp).
- **FR-004**: If the sanitized title is empty after processing, the `title` field MUST be omitted from the payload.

#### EME Bridge (US2)

- **FR-005**: When the user clicks a RAW format button (`format_id === "raw-intercept"`), `content.js` MUST include `title` in the `TRIGGER_DOWNLOAD` message so `background.js` can attach it to the daemon payload.
- **FR-006**: `background.js`'s existing `TRIGGER_DOWNLOAD` handler for `raw-intercept` MUST already attach `pssh`, `license_url`, `license_headers`, `drm_hint`, and `title` from `tabBuffers` — **verify this path is complete and functional**.
- **FR-007**: For non-RAW formats, the `TRIGGER_DOWNLOAD` handler MUST pass `title` through to the daemon payload without modifying the existing yt-dlp routing.
- **FR-008**: `content.js` MUST NOT directly access `tabBuffers` — all DRM metadata enrichment happens in `background.js` per Constitution Principle VIII.

#### Auto-Widevine Backend (US3)

- **FR-009**: The `M3u8Client._resolve_keys()` method MUST check for `pssh` + `license_url` in the `DownloadRequest` and invoke `WidevineCDM.negotiate_keys()` when present — **this already exists** and must be verified end-to-end.
- **FR-010**: The `WidevineCDM._ensure_cdm()` method MUST load `device.wvd` from the path configured in `WVD_PATH` — **this already exists** and must be verified.
- **FR-011**: Each extracted `KID:KEY` pair MUST be appended as a separate `--key` flag to the `N_m3u8DL-RE` command — **this already exists** in `M3u8Client.execute()`.
- **FR-012**: The `.env` file MUST contain `WVD_PATH=device.wvd` (relative path to the project root).
- **FR-013**: The backend's `/api/download` endpoint MUST accept `pssh`, `license_url`, and `license_headers` in the request body — **this already exists** in `DownloadRequest` model.

### Key Entities

- **Download Payload**: The JSON message sent from `content.js` → `background.js` → daemon. Now enriched with `title`, `pssh`, `license_url`, `license_headers`.
- **Tab Buffer**: Per-tab state in `background.js` holding intercepted DRM metadata (`pssh`, `licenseUrl`, `licenseHeaders`, `manifestUrl`, `title`, `drmHint`).
- **WidevineCDM**: Backend class that loads `device.wvd` and negotiates license server exchanges to extract content keys.
- **Sanitized Title**: A filesystem-safe string derived from `document.title` with site suffixes, illegal characters, and excess whitespace removed.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Clicking any format button produces a `TRIGGER_DOWNLOAD` payload containing a sanitized `title` field that is a valid filename (no illegal characters, ≤ 200 chars) on 100% of tested sites.
- **SC-002**: Clicking the RAW button on a DRM-protected page produces a payload containing `pssh`, `license_url`, and `license_headers` — verified by background console logs.
- **SC-003**: An end-to-end DRM download (RAW click → CDM negotiation → `N_m3u8DL-RE` → decrypted `.mp4`) completes successfully when `device.wvd` is present and the license server is reachable.
- **SC-004**: The output file is named `{sanitized_title}.mp4`, not a hash-based fallback, when a title is provided.
- **SC-005**: When `device.wvd` is absent, the backend returns a clear error message within 2 seconds — no hang, no crash.
- **SC-006**: Backward compatibility: pre-extracted `drm_keys` still work without CDM negotiation, and non-DRM downloads are completely unaffected.

---

## Assumptions

- The `eme_hook.js` + `bridge.js` DRM interception pipeline is stable and continues to capture `pssh`, `licenseUrl`, and `licenseHeaders` into `tabBuffers` reliably.
- `device.wvd` is a valid Widevine L3 CDM device file. The system does not validate the device file's integrity beyond what `pywidevine` checks internally.
- The `WidevineCDM` class and `M3u8Client._resolve_keys()` method are already implemented and functional — this feature primarily connects the frontend UI to the existing backend pipeline.
- The `background.js` `TRIGGER_DOWNLOAD` handler for `raw-intercept` already enriches the payload with DRM metadata from `tabBuffers` — this feature verifies and completes that path.
- `N_m3u8DL-RE` binary is on `PATH` and functional.
- The `pywidevine` Python package is already installed.
- `WVD_PATH` will be set in `.env` to `device.wvd` (project root relative path).
