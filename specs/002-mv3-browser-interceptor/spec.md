# Feature Specification: UHDD Browser Interceptor (MV3 Extension) — v2

**Feature Branch**: `003-mv3-browser-interceptor`
**Created**: 2026-04-26
**Revised**: 2026-04-26 (v2 — License Proxy Architecture)
**Status**: Active
**Input**: Refactored to capture License Server URL + PSSH + Headers instead of raw keys. The daemon performs Widevine CDM negotiation server-side using `pywidevine`.

## Architecture Change (v1 → v2)

### Why v1 Failed
The browser's Widevine CDM encrypts the content key inside the license response using the CDM's internal private key. JavaScript running in the MAIN world can only see the **encrypted** key bytes — they are useless to `N_m3u8DL-RE`. The files download but remain encrypted.

### v2 Approach (License Proxy)
Instead of extracting keys client-side, the extension captures:
1. The **PSSH** (Protection System Specific Header) from `generateRequest()`'s `initData`
2. The **License Server URL** from the intercepted network request that carries the CDM challenge
3. The **Request Headers** from that license request (authorization tokens, cookies, custom headers)
4. The **Manifest URL** (`.mpd`) — unchanged from v1

The daemon receives this package and uses `pywidevine` with a local `.wvd` (Widevine Device) file to:
1. Generate its own CDM challenge using the PSSH
2. Send the challenge to the License Server URL with the captured headers
3. Parse the license response to extract plaintext `KID:KEY` pairs
4. Pass the keys to `N_m3u8DL-RE` for download + decryption

## User Scenarios & Testing

### User Story 1 - Automatic DRM Stream Interception via License Proxy (Priority: P1)

A user navigates to a website hosting a DRM-protected video. The extension silently intercepts the `.mpd` manifest URL, the PSSH from the EME initData, and the License Server URL with its associated request headers. Once the manifest URL and license metadata are captured, the extension sends the full package to the UHDD daemon. The daemon negotiates with the license server using `pywidevine`, extracts the plaintext `KID:KEY` pairs, and passes them to `N_m3u8DL-RE` for decrypted download.

**Why this priority**: This is the entire reason the extension and daemon integration exists. Without server-side CDM negotiation, DRM content cannot be decrypted.

**Independent Test**: Install the extension, navigate to a DRM-protected DASH page, and verify that the daemon receives the license metadata, successfully negotiates keys, and `N_m3u8DL-RE` produces a decrypted, playable `.mp4` file.

**Acceptance Scenarios**:

1. **Given** the extension is installed and the UHDD daemon is running with a valid `.wvd` file, **When** a user navigates to a page playing a Widevine-encrypted `.mpd` stream, **Then** the extension captures the manifest URL, PSSH, license server URL, and headers, and sends them to the daemon.
2. **Given** the daemon receives a license proxy payload, **When** `pywidevine` successfully negotiates with the license server, **Then** the daemon extracts plaintext `KID:KEY` pairs and passes them to `N_m3u8DL-RE`.
3. **Given** `N_m3u8DL-RE` receives valid keys and a manifest URL, **When** download and decryption complete, **Then** a playable `.mp4` file exists in the `downloads/` directory.
4. **Given** the extension intercepts a `.mpd` manifest via `fetch()` or `XMLHttpRequest`, **Then** the extension captures that URL without interfering with the page's normal playback.

---

### User Story 2 - User Notification on Download Dispatch (Priority: P2)

After the extension successfully sends a payload to the UHDD daemon, the user receives a native Chrome notification confirming the download has been queued. If the daemon is unreachable, the user receives a notification indicating the backend is offline.

**Why this priority**: Without feedback, the user has no way to know whether the extension is working or whether their download was actually queued.

**Independent Test**: Trigger a DRM interception event. Verify a Chrome notification appears with "UHDD: Download Queued". Then stop the daemon and trigger another interception, verifying a notification appears with "UHDD: Backend Offline".

**Acceptance Scenarios**:

1. **Given** the UHDD daemon is running at `http://localhost:8000`, **When** the extension sends a download payload and receives a success response (HTTP 2xx), **Then** a Chrome notification displays with the title "UHDD: Download Queued".
2. **Given** the UHDD daemon is not running, **When** the extension attempts to send a download payload and the request fails, **Then** a Chrome notification displays with the title "UHDD: Backend Offline".

---

### User Story 3 - Non-DRM Manifest Interception (Priority: P3)

A user navigates to a website hosting unencrypted HLS streams (`.m3u8`). The extension detects the manifest URL and sends it to the UHDD daemon without any license metadata. The daemon's yt-dlp engine handles the download.

**Why this priority**: Extends the interception pipeline to non-DRM content.

**Independent Test**: Navigate to a page with an HLS stream, verify the extension captures the `.m3u8` URL and dispatches it to the daemon without license metadata.

**Acceptance Scenarios**:

1. **Given** the extension is installed and the daemon is running, **When** a page loads a `.m3u8` playlist via `fetch()` or `XMLHttpRequest`, **Then** the extension sends a payload to the daemon containing the manifest URL and no license metadata.
2. **Given** the extension has already dispatched a specific manifest URL, **When** the same URL is encountered again on the same page, **Then** the extension does not send a duplicate payload.

---

### Edge Cases

- What happens when the page loads multiple `.mpd` manifests? → Each unique manifest URL gets its own payload dispatch.
- What happens when the license request fires before the `.mpd` URL is captured? → The extension buffers captured data per tab and only dispatches when both the manifest and license metadata are available.
- What happens when the page navigates away mid-capture? → Buffered data for that tab is discarded.
- How does the extension handle iframes? → Content scripts are injected into all frames via `"all_frames": true`.
- What happens if the license server requires special headers (e.g., `Authorization` bearer tokens)? → The extension captures ALL request headers from the intercepted license request.
- What happens if `pywidevine` CDM negotiation fails? → The daemon logs the error and the job is marked as failed with a descriptive error message.
- What happens if no `.wvd` file is configured? → The daemon returns a structured error indicating the Widevine device file is missing.

## Requirements

### Functional Requirements

- **FR-001**: Extension MUST be built as a Chrome Manifest V3 extension with a service worker.
- **FR-002**: Extension MUST inject a content script into the `"MAIN"` world to access the page's JavaScript execution context for EME hooking and network interception.
- **FR-003**: Extension MUST override `window.fetch` and `XMLHttpRequest` to intercept network requests containing `.mpd` or `.m3u8` URLs (manifest capture).
- **FR-004**: Extension MUST intercept the license server request by detecting `fetch`/`XHR` calls that carry binary CDM challenge payloads, capturing the request URL, method, and headers.
- **FR-005**: Extension MUST hook `MediaKeySession.prototype.generateRequest` to extract the raw PSSH/initData and encode it as base64.
- **FR-006**: Extension MUST use a bridge content script running in the isolated world to forward captured data from the MAIN world to the service worker via `chrome.runtime.sendMessage`.
- **FR-007**: Extension MUST send captured payloads to `http://localhost:8000/api/download` as a JSON POST request with the format `{"url": "<manifest_url>", "pssh": "<base64>", "license_url": "<url>", "license_headers": {}}`.
- **FR-008**: Extension MUST display Chrome notifications for dispatch success ("UHDD: Download Queued") and failure ("UHDD: Backend Offline").
- **FR-009**: Extension MUST NOT interfere with the page's normal video playback or DRM license exchange.
- **FR-010**: Extension MUST deduplicate manifest URLs per tab.
- **FR-011**: Extension MUST discard buffered data when the user navigates away or closes the tab.
- **FR-012**: Extension MUST operate entirely without a popup UI.
- **FR-013**: The UHDD daemon MUST accept the new payload fields (`pssh`, `license_url`, `license_headers`) in `POST /api/download`.
- **FR-014**: The UHDD daemon MUST use `pywidevine` with a local `.wvd` file to perform CDM negotiation when `pssh` + `license_url` are present.
- **FR-015**: The UHDD daemon MUST extract plaintext `KID:KEY` pairs from the Widevine license response and pass them to `N_m3u8DL-RE` via the `--key` flag.
- **FR-016**: The UHDD daemon MUST support multiple `--key` flags when multiple keys are extracted (video + audio tracks).

### Key Entities

- **Manifest URL**: A URL ending in `.mpd` or `.m3u8` captured from network requests.
- **PSSH**: Protection System Specific Header extracted from EME `initData`, encoded as base64.
- **License Server URL**: The URL the page's DRM player sends CDM challenges to.
- **License Headers**: HTTP headers from the license request (Authorization, cookies, custom tokens).
- **Interception Buffer**: Per-tab data structure accumulating manifest URL + license metadata until both are available.
- **Download Payload**: JSON object sent to the UHDD daemon containing manifest URL, PSSH, license URL, and license headers.
- **Widevine Device (`.wvd`)**: A binary file containing a Widevine CDM's private key material, used by `pywidevine` to negotiate licenses. Provided by the user.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The extension captures and dispatches a license proxy payload (manifest + PSSH + license URL + headers) within 5 seconds of the video beginning playback.
- **SC-002**: The daemon successfully negotiates plaintext keys via `pywidevine` for at least 3 major streaming sites.
- **SC-003**: Normal video playback on hooked pages is unaffected — no visible errors, no playback interruption.
- **SC-004**: Zero duplicate payloads for the same manifest URL within a single page session.
- **SC-005**: `N_m3u8DL-RE` produces a fully decrypted, playable `.mp4` file when valid keys are negotiated.

## Assumptions

- The user has Chrome 102+ with Manifest V3 support.
- The UHDD daemon is running locally on `http://localhost:8000`.
- Only Widevine DRM is in scope. FairPlay and PlayReady are out of scope.
- The user provides a valid `.wvd` file and configures its path via `WVD_PATH` in `.env`.
- `pywidevine` is added to the daemon's Python dependencies.
- The extension has no build step — plain JavaScript files loaded directly by Chrome.
