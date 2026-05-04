# Feature Specification: Unified Headless Download Daemon (Thunder)

**Feature Branch**: `001-thunder-download-daemon`
**Created**: 2026-04-26
**Status**: Draft
**Input**: User description: "Headless, API-driven backend daemon that intercepts, routes, and executes download requests from a browser extension — routing between aria2, yt-dlp, and N_m3u8DL-RE engines."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Submit a Standard File Download (Priority: P1)

A user clicks a download link in their browser. The browser extension intercepts the request and sends a JSON payload to the daemon's API. The daemon identifies the URL as a standard file (not a media site, not DRM-encrypted), routes it to the aria2 engine, and begins downloading with 16 parallel connections. The user receives an immediate acknowledgment containing a download identifier.

**Why this priority**: Direct file downloads are the most common use case. This is the foundational path that validates the entire request → route → engine pipeline end-to-end.

**Independent Test**: Submit a direct HTTPS file URL (e.g., a `.zip` archive) via the API and verify the file appears in the `downloads/` directory with the correct content.

**Acceptance Scenarios**:

1. **Given** the daemon is running and aria2 is available, **When** a POST request is sent with a standard file URL, **Then** the system returns a JSON acknowledgment with a download ID and status `accepted`.
2. **Given** a download has been accepted, **When** aria2 completes the transfer, **Then** the file is saved to the `downloads/` directory with the correct filename.
3. **Given** the request includes a `user_agent` and `cookies`, **When** the download is dispatched to aria2, **Then** aria2 uses the provided user agent and cookies for the request.
4. **Given** the daemon is running but aria2 is unreachable, **When** a download request arrives, **Then** the system returns a structured error response with an appropriate error code.

---

### User Story 2 - Download Media from a Supported Site (Priority: P2)

A user navigates to a YouTube or Twitter video page. The browser extension captures the page URL and sends it to the daemon. The daemon recognizes the URL as belonging to a supported media site (or containing `.m3u8` without DRM keys), routes it to the yt-dlp engine, and downloads the best available video + audio streams, muxing them into a single `.mp4` or `.mkv` file.

**Why this priority**: Media downloads from streaming sites are the second most frequent use case. This validates the routing logic's ability to distinguish media URLs from standard files and exercises the yt-dlp engine integration.

**Independent Test**: Submit a YouTube video URL via the API and verify that a muxed `.mp4` file appears in the `downloads/` directory.

**Acceptance Scenarios**:

1. **Given** the daemon is running, **When** a POST request is sent with a YouTube URL (no `drm_keys`), **Then** the system routes the request to the yt-dlp engine and returns a JSON acknowledgment.
2. **Given** a media download is in progress, **When** the yt-dlp engine completes extraction, **Then** the best video and audio streams are muxed into a single file in the `downloads/` directory.
3. **Given** the request includes a URL with an `.m3u8` extension and no `drm_keys`, **When** the request is processed, **Then** the system routes it to yt-dlp (not N_m3u8DL-RE).
4. **Given** the yt-dlp engine encounters an unsupported URL, **When** extraction fails, **Then** the system logs the failure and returns a structured error response.

---

### User Story 3 - Download a DRM-Encrypted Stream via License Proxy (Priority: P3)

The browser extension captures the `.mpd` manifest URL, the PSSH from the page's EME pipeline, the License Server URL, and the associated request headers. It sends this package to the daemon. The daemon uses `pywidevine` with a local `.wvd` (Widevine Device) file to negotiate with the license server, extract plaintext `KID:KEY` pairs, and pass them to `N_m3u8DL-RE` for decrypted download. Alternatively, a user can still supply pre-extracted `drm_keys` (KID:KEY) directly for manual overrides.

**Why this priority**: DRM-encrypted streams are a specialized but critical use case. Server-side CDM negotiation is required because the browser's CDM encrypts the content key internally, making client-side extraction impossible.

**Independent Test**: Submit a manifest URL with a PSSH, license server URL, and headers via the API. Verify that the daemon negotiates keys, and a decrypted, playable media file appears in the `downloads/` directory.

**Acceptance Scenarios**:

1. **Given** the daemon is running with a valid `.wvd` file, **When** a POST request is sent with `pssh`, `license_url`, and `license_headers`, **Then** the system uses `pywidevine` to negotiate plaintext keys and routes the download to N_m3u8DL-RE.
2. **Given** a request contains pre-extracted `drm_keys` (KID:KEY), **When** the request is processed, **Then** the system skips CDM negotiation and passes the keys directly to N_m3u8DL-RE.
3. **Given** a request contains a `.mpd` URL without `drm_keys` or `pssh`, **When** the request is processed, **Then** the system routes it to the N_m3u8DL-RE engine (which may fail without keys, logged as an error).
4. **Given** N_m3u8DL-RE completes successfully, **When** decryption and muxing finish, **Then** the output file is saved to the `downloads/` directory and temporary chunks are cleaned up.
5. **Given** `pywidevine` CDM negotiation fails (invalid PSSH, license server rejection, missing `.wvd` file), **When** the error occurs, **Then** the system logs a descriptive error and the job is marked as failed.

---

### User Story 4 - Check Download Status (Priority: P2)

A user wants to know the progress of a previously submitted download. They query the daemon's API with the download ID received at submission time. The daemon returns the current status (queued, downloading, completed, failed) along with progress metadata where applicable.

**Why this priority**: Without status visibility, users have no way to know whether a download succeeded, is still running, or failed. This is essential for any non-trivial usage of the daemon.

**Independent Test**: Submit a download, then query its status endpoint and verify the response includes the correct state and progress information.

**Acceptance Scenarios**:

1. **Given** a download has been submitted, **When** a status query is sent with the download ID, **Then** the system returns the current state (`queued`, `downloading`, `completed`, or `failed`).
2. **Given** a download is in progress, **When** status is queried, **Then** the response includes progress information (percentage, speed, or ETA where available from the engine).
3. **Given** a download has completed, **When** status is queried, **Then** the response includes the output file path and final file size.
4. **Given** an invalid or unknown download ID, **When** status is queried, **Then** the system returns a `404` error with a descriptive message.

---

### Edge Cases

- What happens when the daemon receives two identical URLs simultaneously? The system MUST accept both and process them independently (no deduplication).
- How does the system handle extremely long filenames from yt-dlp? Filenames MUST be truncated to 200 characters (excluding extension) to remain filesystem-safe.
- What happens when the `downloads/` directory runs out of disk space? The system MUST return a structured error and log the disk space exhaustion event.
- How does the system handle malformed JSON payloads? The API MUST return a `422` validation error with details about the malformed fields.
- What happens when aria2, yt-dlp, or N_m3u8DL-RE binaries are missing at startup? The system MUST perform a health check on startup and warn about missing engines without crashing — requests to unavailable engines MUST return a clear error.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST expose a single unified endpoint (`POST /api/download`) that accepts JSON payloads containing `url` (required), `cookies` (optional), `user_agent` (optional), `drm_keys` (optional, formatted as `KID:KEY`), `pssh` (optional, base64-encoded PSSH), `license_url` (optional, license server URL), and `license_headers` (optional, dict of HTTP headers).
- **FR-001b**: When `pssh` and `license_url` are present (and `drm_keys` is absent), the system MUST use `pywidevine` with a local `.wvd` file to negotiate with the license server and extract plaintext `KID:KEY` pairs before dispatching to `N_m3u8DL-RE`.
- **FR-002**: The system MUST route requests to the correct engine based on deterministic rules: `drm_keys` present OR `pssh`+`license_url` present OR `.mpd` URL → N_m3u8DL-RE; URL matches known media sites OR `.m3u8` (without DRM keys/PSSH) → yt-dlp; all others → aria2.
- **FR-003**: The system MUST return a unique download identifier in the acknowledgment response for every accepted request.
- **FR-004**: The system MUST provide a status endpoint (`GET /api/download/{id}`) returning the current state and progress of a download.
- **FR-005**: The aria2 engine MUST use 16 parallel connections per download and forward `user_agent` and `cookies` from the request payload.
- **FR-006**: The yt-dlp engine MUST download the best available video + audio streams and mux them into a single `.mp4` or `.mkv` file.
- **FR-007**: The N_m3u8DL-RE engine MUST accept the manifest URL and `KID:KEY` pair(s), select the best tracks automatically, and clean up temporary files after completion. Multiple `--key` flags MUST be supported when multiple keys are extracted (e.g., separate video and audio keys).
- **FR-008**: All downloads MUST be saved to a unified `downloads/` directory.
- **FR-009**: All log output MUST be written in structured JSON format to a `logs/` directory.
- **FR-010**: The system MUST perform engine availability health checks at startup and expose a health endpoint (`GET /api/health`) reporting which engines are operational.
- **FR-011**: Long-running downloads MUST execute as background operations; the API MUST NOT block while a download is in progress.
- **FR-012**: All error responses MUST be structured JSON containing a machine-readable error code and a human-readable message.

### Key Entities

- **Download Request**: Represents an incoming download submission — contains the URL, optional authentication data (cookies, user agent), optional DRM keys, and a timestamp.
- **Download Job**: Represents an active or completed download — tracks the assigned engine, current state (queued/downloading/completed/failed), progress metadata, output file path, and error details.
- **Engine**: Represents a download backend (aria2, yt-dlp, N_m3u8DL-RE) — tracks availability status and configuration parameters.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can submit a download request and receive an acknowledgment within 2 seconds.
- **SC-002**: The routing engine correctly classifies 100% of URLs according to the defined routing rules (deterministic, no ambiguity).
- **SC-003**: Standard file downloads via aria2 utilize all 16 parallel connections, achieving throughput limited only by network bandwidth (not by the daemon).
- **SC-004**: Media site downloads produce a single playable media file (not separate audio/video fragments) in the output directory.
- **SC-005**: DRM-encrypted stream downloads produce a decrypted, playable media file when valid keys are provided.
- **SC-006**: The daemon operates continuously without user interaction for 7+ days without memory leaks or unhandled crashes.
- **SC-007**: All download lifecycle events are queryable via the status endpoint within 1 second of state change.
- **SC-008**: The system starts up and is ready to accept requests within 10 seconds, including engine health checks.

## Assumptions

- The aria2 daemon (`aria2c`) is pre-installed and running on the same host with RPC enabled.
- The `N_m3u8DL-RE` binary is pre-installed and available on the system PATH.
- `ffmpeg` is pre-installed for yt-dlp muxing operations.
- The browser extension (Feature 002) captures and forwards license metadata to the daemon.
- Users may provide pre-extracted `KID:KEY` pairs OR the extension provides `pssh` + `license_url` + `license_headers` for server-side CDM negotiation.
- A valid `.wvd` (Widevine Device) file is required for CDM negotiation and must be configured via `WVD_PATH` in `.env`.
- `pywidevine` is added as a Python dependency for Widevine CDM negotiation.
- The daemon runs on a single host; distributed/clustered deployment is out of scope for v1.
- The system targets Linux as the primary platform; macOS is best-effort; Windows is out of scope.
- Headless JDownloader 2 integration is reserved for a future v2.0 release and excluded from this specification.
