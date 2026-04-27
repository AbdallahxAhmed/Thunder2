# Feature Specification: UHDD Browser Interceptor (MV3 Extension) — v4

**Feature Branch**: `003-mv3-browser-interceptor`
**Created**: 2026-04-26
**Revised**: 2026-04-27 (v4 — IDM-Style Floating Download Button)
**Status**: Active
**Input**: v2 established License Proxy Architecture for DRM streams. v3 added "The Native Download Hijacker" — intercepting Chrome's native file downloads and routing them to aria2 via the daemon. v4 adds "The IDM-Style Floating Download Button" — a content script that detects `<video>` elements on any page and injects a premium floating download button with an inline quality picker dropdown.

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

## v3 Addition: The Native Download Hijacker

### Motivation
Chrome's built-in download manager is single-threaded and provides no acceleration, no segmented downloads, and no integration with the UHDD pipeline. Files that Chrome would normally download natively (PDFs, ZIPs, ISOs, executables, etc.) should instead be routed to aria2 for multi-connection acceleration.

### v3 Approach (Download Hijacker)
The extension uses the `chrome.downloads` API to intercept every download Chrome initiates:
1. The `chrome.downloads.onCreated` event fires when Chrome starts a native download.
2. The extension immediately **cancels** the native download via `chrome.downloads.cancel()`.
3. The extension extracts download metadata: **URL**, **Referer**, **User-Agent**, and **Cookies** (via `chrome.cookies.getAll()`).
4. The extension dispatches a JSON payload to the UHDD daemon (`/api/download`) with `engine: "aria2"` to explicitly request the aria2 engine.
5. An **Anti-Loop Guard** prevents infinite recursion — downloads initiated by the daemon or aria2 itself must not be re-intercepted.

## v4 Addition: The IDM-Style Floating Download Button

### Motivation
The popup-based Quality Picker (spec 003) requires the user to click the extension icon in the Chrome toolbar. For video-heavy browsing, users expect an **in-page download button** that appears directly over the video player — exactly like IDM's famous floating download bar. This provides zero-friction access to quality selection without leaving the page.

### v4 Approach (Content Script — Floating Button)
The extension injects a content script (`content.js`) and stylesheet (`content.css`) into all pages:
1. A `MutationObserver` watches for `<video>` elements being added to the DOM.
2. When a `<video>` is detected, the script locates the video's **direct parent container** (e.g., `.html5-video-player` on YouTube) and injects a floating download button into it.
3. The injection is **idempotent** — the container is marked with `data-uhdd-injected="true"` to prevent duplicate buttons on DOM mutations.
4. The floating button starts as a small icon (positioned `absolute`, `top: 10px`, `right: 10px` within the container).
5. On click, the button sends `{type: "getFormats"}` to `background.js` via `chrome.runtime.sendMessage` to fetch pre-cached quality options.
6. Once data arrives, a **mini-dropdown** (Dark Mode) renders inline over the video, showing available quality tiers.
7. Clicking a quality option dispatches the download payload to the daemon (`POST /api/download` with `format_id`) and shows a temporary success indicator.
8. The dropdown auto-closes on selection or when clicking outside.
9. For **SPA handling**, the observer handles URL changes gracefully — the `<video>` element may be reused across navigations.


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

### User Story 4 - Native Download Hijacking to aria2 (Priority: P2)

A user clicks a direct download link on any website (e.g., a PDF, ZIP, ISO, or executable). Instead of Chrome's built-in download manager handling the file, the extension intercepts the download via `chrome.downloads.onCreated`, cancels it, captures the URL along with the Referer header, User-Agent string, and site cookies, then dispatches the download to the UHDD daemon with an explicit `engine: "aria2"` directive. The daemon routes it to aria2 for multi-connection accelerated downloading.

**Why this priority**: Bringing all direct file downloads under UHDD's control completes the interception pipeline — DRM streams (P1), notifications (P2), HLS (P3), and now generic files. aria2's segmented downloading provides significantly faster transfers than Chrome's single-threaded downloader.

**Independent Test**: Install the extension, click a direct download link (e.g., a large ISO file), verify that Chrome's native download is cancelled, the daemon receives the payload with the correct URL, Referer, User-Agent, and Cookies, and aria2 begins the download.

**Acceptance Scenarios**:

1. **Given** the extension is installed with the `"downloads"` permission and the daemon is running, **When** a user clicks a direct download link on any website, **Then** Chrome's native download is cancelled and the extension dispatches the URL, Referer, User-Agent, and Cookies to the daemon with `engine: "aria2"`.
2. **Given** the extension dispatches a download to the daemon, **When** the daemon processes the request with `engine: "aria2"`, **Then** aria2 begins downloading the file using multi-connection acceleration.
3. **Given** the anti-loop guard is active, **When** a download originates from `localhost` or is flagged as daemon-initiated, **Then** the extension does NOT intercept or cancel that download.
4. **Given** the daemon is unreachable, **When** the extension attempts to dispatch a hijacked download, **Then** a notification displays "UHDD: Backend Offline" and the original download is NOT cancelled (graceful fallback).

---

### User Story 5 - IDM-Style Floating Download Button on Video Players (Priority: P2)

A user navigates to any website containing a `<video>` element (e.g., YouTube, Vimeo, or any HTML5 video player). The extension automatically detects the video element, injects a floating download button directly over the video player, and provides instant access to quality selection without opening the extension popup. Clicking the button reveals a sleek dark-mode mini-dropdown of available qualities. Selecting a quality dispatches the download to the UHDD daemon and shows a brief success indicator.

**Why this priority**: The floating button provides zero-friction access to downloads — users don't need to remember to click the toolbar icon. This is the most natural UX for video downloading, matching user expectations set by IDM and similar tools.

**Independent Test**: Install the extension, navigate to YouTube, verify a floating download icon appears over the video player. Click it, verify a quality dropdown appears with options. Click a quality, verify the download is dispatched to the daemon.

**Acceptance Scenarios**:

1. **Given** the extension is installed and a page contains a `<video>` element, **When** the video element is added to the DOM, **Then** a floating download button appears positioned over the video player within 1 second.
2. **Given** the floating button is visible, **When** the user clicks it, **Then** the button sends `{type: "getFormats"}` to the background script and renders a mini-dropdown with available quality options.
3. **Given** the quality dropdown is visible, **When** the user clicks a quality option, **Then** the extension dispatches `{url, engine: "ytdlp", format_id}` to the daemon and shows a temporary success indicator.
4. **Given** the content script has already injected a button into a container, **When** the DOM mutates and the MutationObserver fires again, **Then** no duplicate button is injected (idempotency via `data-uhdd-injected` attribute).
5. **Given** the user is on a SPA (e.g., YouTube) and navigates to a new video, **When** the `<video>` element is reused by the page, **Then** the floating button remains functional and fetches fresh format data for the new URL.
6. **Given** the daemon is offline, **When** the user clicks the floating button, **Then** the dropdown shows a "Backend offline" error message.

---

### Edge Cases

- What happens when the page loads multiple `.mpd` manifests? → Each unique manifest URL gets its own payload dispatch.
- What happens when the license request fires before the `.mpd` URL is captured? → The extension buffers captured data per tab and only dispatches when both the manifest and license metadata are available.
- What happens when the page navigates away mid-capture? → Buffered data for that tab is discarded.
- How does the extension handle iframes? → Content scripts are injected into all frames via `"all_frames": true`.
- What happens if the license server requires special headers (e.g., `Authorization` bearer tokens)? → The extension captures ALL request headers from the intercepted license request.
- What happens if `pywidevine` CDM negotiation fails? → The daemon logs the error and the job is marked as failed with a descriptive error message.
- What happens if no `.wvd` file is configured? → The daemon returns a structured error indicating the Widevine device file is missing.
- What happens if Chrome fires `onCreated` for a download that the extension itself triggered? → The anti-loop guard checks the download URL against a set of known daemon-originated URLs and skips interception.
- What happens if Chrome fires `onCreated` for a download from `localhost`? → Downloads from `localhost` or `127.0.0.1` are excluded from hijacking to prevent intercepting daemon-served files.
- What happens if the daemon is offline when a native download is hijacked? → The extension does NOT cancel the native download. It first validates daemon reachability, then cancels only on confirmed dispatch.
- What happens if cookie access is denied for the download domain? → The extension dispatches the payload without cookies; the `cookies` field is optional.
- What happens if the file URL triggers both the manifest interception and the download hijacker? → Streaming manifests (`.mpd`, `.m3u8`) are excluded from download hijacking since they are already handled by the content script pipeline.
- What happens if a page has multiple `<video>` elements? → Each video's parent container gets its own floating button, each independently tracked by `data-uhdd-injected`.
- What happens if the video element is inside a Shadow DOM? → The MutationObserver watches the main document; Shadow DOM videos are out of scope for v4.
- What happens if the floating button overlaps with the site's native video controls? → The button is positioned at `top: 10px, right: 10px` to avoid the bottom-anchored native controls.
- What happens if the video element is removed and re-added? → The MutationObserver detects the new element and injects a fresh button (the old `data-uhdd-injected` marker is gone with the removed DOM).
- What happens if the user clicks outside the dropdown while it's open? → The dropdown closes via a `document.addEventListener("click")` handler.
- What happens if the page has strict Content Security Policy (CSP)? → Content scripts injected by Chrome extensions are exempt from page CSP restrictions.
- What happens if the video enters fullscreen? → The button is injected into the video's parent container, so it naturally follows fullscreen transitions.

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
- **FR-012**: Extension MUST provide two complementary UI surfaces: a toolbar popup (Quality Picker) and an in-page floating button (Content Script), both capable of dispatching downloads independently.
- **FR-013**: The UHDD daemon MUST accept the new payload fields (`pssh`, `license_url`, `license_headers`) in `POST /api/download`.
- **FR-014**: The UHDD daemon MUST use `pywidevine` with a local `.wvd` file to perform CDM negotiation when `pssh` + `license_url` are present.
- **FR-015**: The UHDD daemon MUST extract plaintext `KID:KEY` pairs from the Widevine license response and pass them to `N_m3u8DL-RE` via the `--key` flag.
- **FR-016**: The UHDD daemon MUST support multiple `--key` flags when multiple keys are extracted (video + audio tracks).
- **FR-017**: Extension manifest MUST include the `"downloads"` permission to access the `chrome.downloads` API.
- **FR-018**: Extension MUST register a `chrome.downloads.onCreated` listener in the service worker to intercept all native downloads.
- **FR-019**: Extension MUST cancel intercepted native downloads via `chrome.downloads.cancel()` ONLY after confirming successful dispatch to the daemon.
- **FR-020**: Extension MUST extract the download URL, Referer (from the originating tab), User-Agent, and Cookies (via `chrome.cookies.getAll()` for the download domain) from each intercepted download.
- **FR-021**: Extension MUST implement an anti-loop guard that prevents re-interception of downloads originating from `localhost`, `127.0.0.1`, or URLs matching a known daemon-initiated download set.
- **FR-022**: Extension MUST send hijacked download payloads to `POST /api/download` with the format `{"url": "<file_url>", "referer": "<referer>", "user_agent": "<ua>", "cookies": "<cookie_string>", "engine": "aria2"}`.
- **FR-023**: The UHDD daemon `DownloadRequest` model MUST accept optional `referer`, `user_agent`, `cookies`, and `engine` fields.
- **FR-024**: The UHDD daemon router MUST respect an explicit `engine` field in the request payload, bypassing normal URL classification when `engine` is provided.
- **FR-025**: Extension manifest MUST include a `content_scripts` block that injects `content.js` and `content.css` on `<all_urls>` in the `ISOLATED` world at `document_idle` with `all_frames: true`.
- **FR-026**: Extension `content.js` MUST use a `MutationObserver` (NOT `setInterval`) to detect `<video>` elements added to the DOM.
- **FR-027**: Extension `content.js` MUST inject a floating download button into the video's direct parent container, positioned absolutely at `top: 10px, right: 10px`.
- **FR-028**: Extension `content.js` MUST mark injected containers with `data-uhdd-injected="true"` to ensure idempotent injection — no duplicate buttons on DOM mutation.
- **FR-029**: Extension `content.js` MUST send `{type: "getFormats"}` to `background.js` via `chrome.runtime.sendMessage` when the floating button is clicked, receiving the pre-cached quality data.
- **FR-030**: Extension `content.js` MUST render a dark-mode mini-dropdown over the video player containing the available quality options when format data is received.
- **FR-031**: Extension `content.js` MUST dispatch `{url, engine: "ytdlp", format_id}` to `POST /api/download` when the user selects a quality from the dropdown, and display a temporary success indicator.
- **FR-032**: Extension `content.css` MUST define scoped CSS custom properties for the floating button and dropdown using the established dark theme (`--bg-main: #0F172A`, `--accent: #6366F1`).
- **FR-033**: Extension `content.css` MUST ensure the floating button and dropdown remain on top of page content via a high `z-index` value (≥ 2147483640).
- **FR-034**: Extension `content.js` MUST close the dropdown when the user clicks outside of it or after a quality is selected.
- **FR-035**: Extension `content.js` MUST handle SPA navigations by detecting URL changes and refreshing format data when the `<video>` element is reused across page transitions.

### Key Entities

- **Manifest URL**: A URL ending in `.mpd` or `.m3u8` captured from network requests.
- **PSSH**: Protection System Specific Header extracted from EME `initData`, encoded as base64.
- **License Server URL**: The URL the page's DRM player sends CDM challenges to.
- **License Headers**: HTTP headers from the license request (Authorization, cookies, custom tokens).
- **Interception Buffer**: Per-tab data structure accumulating manifest URL + license metadata until both are available.
- **Download Payload**: JSON object sent to the UHDD daemon containing manifest URL, PSSH, license URL, and license headers.
- **Widevine Device (`.wvd`)**: A binary file containing a Widevine CDM's private key material, used by `pywidevine` to negotiate licenses. Provided by the user.
- **Hijacked Download**: A native Chrome download intercepted by `chrome.downloads.onCreated`, cancelled, and re-dispatched to the daemon for aria2 handling.
- **Anti-Loop Guard**: A mechanism (URL set + localhost check) that prevents the extension from re-intercepting downloads that the daemon or aria2 itself initiated.
- **Download Metadata**: The set of HTTP context captured from a hijacked download: URL, Referer header, User-Agent string, and serialized cookies.
- **Floating Button**: A small, absolutely-positioned download icon injected into a video player's parent container, serving as the entry point for the in-page quality picker.
- **Mini-Dropdown**: A dark-mode overlay rendered inline over the video player, displaying available download qualities fetched from the background script's format cache.
- **Injection Marker**: The `data-uhdd-injected` attribute set on a video container to track whether the floating button has already been injected, preventing duplicates.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The extension captures and dispatches a license proxy payload (manifest + PSSH + license URL + headers) within 5 seconds of the video beginning playback.
- **SC-002**: The daemon successfully negotiates plaintext keys via `pywidevine` for at least 3 major streaming sites.
- **SC-003**: Normal video playback on hooked pages is unaffected — no visible errors, no playback interruption.
- **SC-004**: Zero duplicate payloads for the same manifest URL within a single page session.
- **SC-005**: `N_m3u8DL-RE` produces a fully decrypted, playable `.mp4` file when valid keys are negotiated.
- **SC-006**: 100% of native Chrome file downloads (non-streaming) are intercepted and routed to aria2 within 1 second of Chrome initiating the download.
- **SC-007**: Zero download loops — the anti-loop guard prevents all daemon-initiated downloads from being re-intercepted.
- **SC-008**: When the daemon is offline, native downloads fall through to Chrome's default handler with zero data loss.
- **SC-009**: aria2 downloads initiated via the hijacker include correct Referer, User-Agent, and Cookies, resulting in successful downloads from sites that enforce these headers.
- **SC-010**: The floating download button appears over a `<video>` element within 1 second of the video being added to the DOM.
- **SC-011**: Zero duplicate floating buttons are injected per video container across any number of DOM mutations.
- **SC-012**: The mini-dropdown renders quality options within 500ms of clicking the floating button (leveraging pre-cached format data).
- **SC-013**: The floating button remains functional and correctly positioned when the video enters fullscreen mode.

## Assumptions

- The user has Chrome 102+ with Manifest V3 support.
- The UHDD daemon is running locally on `http://localhost:8000`.
- Only Widevine DRM is in scope. FairPlay and PlayReady are out of scope.
- The user provides a valid `.wvd` file and configures its path via `WVD_PATH` in `.env`.
- `pywidevine` is added to the daemon's Python dependencies.
- The extension has no build step — plain JavaScript files loaded directly by Chrome.
- The `"downloads"` permission is acceptable to the user (it will appear in the extension's permission prompt).
- The `"cookies"` permission may be needed if `chrome.cookies.getAll()` is used; if host_permissions `*://*/*` already grants cookie access, no additional permission is required.
- aria2 is already configured and running as part of the UHDD daemon stack.
- Downloads from `localhost`/`127.0.0.1` are assumed to be daemon-initiated and are never hijacked.
- The floating button uses `position: absolute` within the video's parent container, which is assumed to have `position: relative` (or the content script sets it).
- Shadow DOM video elements are out of scope for v4 — only main-document `<video>` elements are targeted.
