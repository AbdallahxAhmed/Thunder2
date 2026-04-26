# Feature Specification: UHDD Browser Interceptor (MV3 Extension)

**Feature Branch**: `003-mv3-browser-interceptor`
**Created**: 2026-04-26
**Status**: Draft
**Input**: User description: "A Chrome Manifest V3 extension that runs in the background, intercepts DRM video manifests (.mpd) and Widevine decryption keys (KID:KEY), and automatically sends them to the local UHDD API for headless downloading."

## User Scenarios & Testing

### User Story 1 - Automatic DRM Stream Interception (Priority: P1)

A user navigates to a website hosting a DRM-protected video. The extension silently intercepts the `.mpd` manifest URL from the page's network requests and the Widevine `KID:KEY` pair from the browser's Encrypted Media Extensions (EME) pipeline. Once both pieces of data are captured, the extension automatically sends the payload to the local UHDD daemon for download — all without any user interaction.

**Why this priority**: This is the entire reason the extension exists. Without the ability to capture both the manifest URL and DRM keys from a browsing session, no other feature has value. It is the core pipeline.

**Independent Test**: Install the extension, navigate to a DRM-protected streaming page (e.g., a sample DASH player with Widevine), and verify that the extension detects the `.mpd` URL and the `KID:KEY` pair, then sends a POST request to `http://localhost:8000/api/download`.

**Acceptance Scenarios**:

1. **Given** the extension is installed and the UHDD daemon is running, **When** a user navigates to a page playing a Widevine-encrypted `.mpd` stream, **Then** the extension captures the manifest URL and the `KID:KEY` pair and sends them as a JSON payload to the local daemon's download endpoint.
2. **Given** the extension is installed, **When** a page loads a `.mpd` manifest via `fetch()` or `XMLHttpRequest`, **Then** the extension captures that URL without interfering with the page's normal playback.
3. **Given** the extension is installed, **When** the browser's EME pipeline processes a Widevine license exchange, **Then** the extension extracts the `KID` from the `initData` and the `KEY` from the license response, both in lowercase hexadecimal format.

---

### User Story 2 - User Notification on Download Dispatch (Priority: P2)

After the extension successfully sends a payload to the UHDD daemon, the user receives a native Chrome notification confirming the download has been queued. If the daemon is unreachable, the user receives a notification indicating the backend is offline.

**Why this priority**: Without feedback, the user has no way to know whether the extension is working or whether their download was actually queued. Notifications close this feedback loop with minimal UI complexity.

**Independent Test**: Trigger a DRM interception event. Verify a Chrome notification appears with "UHDD: Download Queued". Then stop the daemon and trigger another interception, verifying a notification appears with "UHDD: Backend Offline".

**Acceptance Scenarios**:

1. **Given** the UHDD daemon is running at `http://localhost:8000`, **When** the extension sends a download payload and receives a success response (HTTP 2xx), **Then** a Chrome notification displays with the title "UHDD: Download Queued".
2. **Given** the UHDD daemon is not running, **When** the extension attempts to send a download payload and the request fails (network error or non-2xx), **Then** a Chrome notification displays with the title "UHDD: Backend Offline".

---

### User Story 3 - Non-DRM Manifest Interception (Priority: P3)

A user navigates to a website hosting unencrypted HLS streams (`.m3u8`). The extension detects the manifest URL and sends it to the UHDD daemon without any DRM keys. This allows the daemon's yt-dlp engine to handle non-DRM streaming content as well.

**Why this priority**: Extends the interception pipeline to non-DRM content, broadening the extension's usefulness. However, non-DRM downloads can already be handled by other means (e.g., copy-pasting the URL), so this is additive rather than essential.

**Independent Test**: Navigate to a page with an HLS stream, verify the extension captures the `.m3u8` URL and dispatches it to the daemon with the `drm_keys` field omitted from the payload.

**Acceptance Scenarios**:

1. **Given** the extension is installed and the daemon is running, **When** a page loads a `.m3u8` playlist via `fetch()` or `XMLHttpRequest`, **Then** the extension sends a payload to the daemon containing the manifest URL and no `drm_keys`.
2. **Given** the extension has already dispatched a specific manifest URL, **When** the same URL is encountered again on the same page, **Then** the extension does not send a duplicate payload.

---

### Edge Cases

- What happens when the page loads multiple `.mpd` manifests (e.g., multi-video pages)? → Each unique manifest URL gets its own payload dispatch.
- What happens when the `KID:KEY` extraction completes before the `.mpd` URL is captured (or vice versa)? → The extension buffers captured data per tab and only dispatches when both pieces are available.
- What happens when the page navigates away mid-capture? → Buffered data for that tab is discarded on tab navigation or close.
- How does the extension handle iframes? → Content scripts are injected into all frames via `"all_frames": true`, so manifests inside iframes are also intercepted.
- What happens if the EME hook cannot extract keys (e.g., non-Widevine DRM)? → The extension only intercepts Widevine. Other DRM systems (FairPlay, PlayReady) are out of scope.

## Requirements

### Functional Requirements

- **FR-001**: Extension MUST be built as a Chrome Manifest V3 extension with a service worker (no persistent background page).
- **FR-002**: Extension MUST inject a content script into the `"MAIN"` world to access the page's JavaScript execution context for EME hooking.
- **FR-003**: Extension MUST override `window.fetch` and `XMLHttpRequest` to intercept network requests containing `.mpd` or `.m3u8` URLs.
- **FR-004**: Extension MUST hook `navigator.requestMediaKeySystemAccess` and the resulting `MediaKeySession` to capture the Widevine `KID` and `KEY` in hexadecimal format.
- **FR-005**: Extension MUST use a bridge content script running in the isolated world to forward captured data from the MAIN world to the service worker via `chrome.runtime.sendMessage`.
- **FR-006**: Extension MUST send captured payloads to `http://localhost:8000/api/download` as a JSON POST request with the format `{"url": "<manifest_url>", "drm_keys": "<kid:key>"}`.
- **FR-007**: Extension MUST display a Chrome notification ("UHDD: Download Queued") when a payload is successfully sent to the daemon.
- **FR-008**: Extension MUST display a Chrome notification ("UHDD: Backend Offline") when the daemon is unreachable.
- **FR-009**: Extension MUST NOT interfere with the page's normal video playback or DRM license exchange.
- **FR-010**: Extension MUST deduplicate manifest URLs per tab to avoid sending the same payload multiple times for the same stream.
- **FR-011**: Extension MUST discard buffered interception data when the user navigates away from the page or closes the tab.
- **FR-012**: Extension MUST operate entirely without a popup UI — all functionality is silent and automatic.

### Key Entities

- **Manifest URL**: A URL ending in `.mpd` or `.m3u8` captured from network requests. Represents the video stream to be downloaded.
- **DRM Key Pair**: A `KID:KEY` string in hexadecimal format extracted from the Widevine EME pipeline. Required for decrypting protected streams.
- **Interception Buffer**: A per-tab data structure that accumulates the manifest URL and DRM key pair until both are available for dispatch.
- **Download Payload**: The JSON object sent to the UHDD daemon, containing the manifest URL and optionally the DRM key pair.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The extension captures and dispatches a DRM payload (manifest + keys) within 5 seconds of the video beginning playback on a Widevine-encrypted page.
- **SC-002**: The extension correctly intercepts manifests and keys on at least 3 major DRM-protected streaming sites without manual user interaction.
- **SC-003**: Normal video playback on hooked pages is unaffected — no visible errors, no playback interruption, no console errors caused by the extension.
- **SC-004**: The extension produces zero duplicate payloads for the same manifest URL within a single page session.
- **SC-005**: Users are notified of every dispatch attempt (success or failure) within 2 seconds of the attempt via Chrome notification.

## Assumptions

- The user has Chrome (or a Chromium-based browser) version 102+ which supports Manifest V3 content scripts in the MAIN world.
- The UHDD daemon is running locally on `http://localhost:8000` before the extension attempts to dispatch payloads.
- Only Widevine DRM is in scope. FairPlay (Safari) and PlayReady (Edge-specific) are out of scope for this extension.
- The extension does not handle key rotation — it captures the first `KID:KEY` pair per session.
- The extension directory lives at `extension/` in the project root, alongside the existing `src/` backend code.
- The extension has no build step — it consists of plain JavaScript files loaded directly by Chrome.
