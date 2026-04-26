# Research: UHDD Browser Interceptor (MV3 Extension)

**Date**: 2026-04-26
**Feature**: [spec.md](spec.md)
**Purpose**: Resolve all technical unknowns for the MV3 extension implementation.

## R1: MAIN World Content Script Injection (MV3)

**Decision**: Use `manifest.json` `content_scripts` entry with `"world": "MAIN"` to
inject `eme_hook.js` into the page's execution context.

**Rationale**: Chrome 102+ supports `"world": "MAIN"` in manifest-declared content
scripts. This grants direct access to the page's `navigator.requestMediaKeySystemAccess`,
`window.fetch`, and `XMLHttpRequest` — all required for EME/network interception.
The `mv3_eme_hook.md` skill confirms this approach.

**Alternatives considered**:
- `chrome.scripting.executeScript({ world: "MAIN" })` from the service worker:
  Requires `scripting` permission and explicit tab ID. More complex, harder to guarantee
  early injection before the page's own scripts run. Rejected.
- Injecting a `<script>` tag from an isolated-world content script: Works but adds
  timing complexity and an extra DOM mutation. Rejected.

**Key configuration**:
```json
{
  "content_scripts": [
    {
      "matches": ["*://*/*"],
      "js": ["content_scripts/eme_hook.js"],
      "world": "MAIN",
      "run_at": "document_start",
      "all_frames": true
    }
  ]
}
```

## R2: EME Hook — Extracting KID and KEY

**Decision**: Override `navigator.requestMediaKeySystemAccess` to intercept the
`MediaKeySystemAccess` object. Then wrap `MediaKeySession.prototype.update` to
capture the license response containing the decryption key. Extract `KID` from
the session's `initData` (PSSH box parsing) and `KEY` from the Widevine license
response (CENC key container).

**Rationale**: The Widevine CDM flow is:
1. Page calls `navigator.requestMediaKeySystemAccess("com.widevine.alpha", ...)`
2. CDM creates a `MediaKeySession`
3. Page generates a license request from `initData` (contains KID in PSSH)
4. Page sends license request to license server, gets response
5. Page calls `session.update(licenseResponse)` — this contains the KEY

By hooking step 1 and step 5, we capture both KID and KEY.

**Alternatives considered**:
- Hooking `MediaKeys.createSession()` only: Would miss the `initData` needed for KID.
- Using `webRequest` API to intercept license server traffic: MV3 deprecates blocking
  webRequest; `declarativeNetRequest` cannot read response bodies. Rejected.

**Key implementation details**:
- KID extraction: Parse `initData` as a PSSH box. The KID is at a known offset
  in the Widevine PSSH data (bytes 32-48 for a single KID).
- KEY extraction: Parse the Widevine license response protobuf. The content key
  is in the `key` field of the `License.KeyContainer` message.
  A simplified approach: look for 16-byte sequences that follow known Widevine
  protobuf field tags.
- Both KID and KEY are output as lowercase hex strings, formatted as `KID:KEY`.

## R3: Network Request Interception (fetch + XHR)

**Decision**: Override `window.fetch` and `XMLHttpRequest.prototype.open` in the
MAIN world to intercept URLs ending in `.mpd` or `.m3u8`.

**Rationale**: DRM-protected video players load their manifest via standard
network APIs. By wrapping these, we capture the manifest URL before it reaches
the player, without blocking or modifying the request.

**Alternatives considered**:
- `chrome.webRequest.onBeforeRequest`: Deprecated for blocking in MV3. Can still
  observe requests but the API is more complex and runs in the service worker
  (not the page context). Also cannot pair with EME data from the same tab easily.
- `chrome.declarativeNetRequest`: Can redirect/block but cannot read request bodies
  or URLs programmatically. Useless for URL capture.

**Key implementation**:
```javascript
// Fetch override
const originalFetch = window.fetch;
window.fetch = function(input, init) {
  const url = (typeof input === 'string') ? input : input.url;
  if (url.endsWith('.mpd') || url.endsWith('.m3u8')) {
    // Dispatch captured URL
  }
  return originalFetch.apply(this, arguments);
};

// XHR override
const originalXHROpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...args) {
  if (url.endsWith('.mpd') || url.endsWith('.m3u8')) {
    // Dispatch captured URL
  }
  return originalXHROpen.apply(this, [method, url, ...args]);
};
```

## R4: MAIN ↔ Isolated ↔ Service Worker Communication

**Decision**: Use `window.dispatchEvent(new CustomEvent('uhdd_payload_ready', ...))`
from the MAIN world, listened to by the bridge script in the isolated world, which
then calls `chrome.runtime.sendMessage(...)` to reach the service worker.

**Rationale**: MAIN-world scripts cannot access `chrome.runtime` APIs. The bridge
pattern is the canonical MV3 approach: MAIN → custom DOM event → isolated world →
`chrome.runtime.sendMessage` → service worker.

**Alternatives considered**:
- `window.postMessage`: Works but broadcasts to all listeners including the page
  itself. Custom events with a specific name are more targeted.
- Direct `chrome.runtime.sendMessage` from MAIN world: Not available in MAIN world
  content scripts. API is only accessible in isolated world.

**Message flow**:
```
eme_hook.js (MAIN) → CustomEvent('uhdd_payload_ready', {url, drm_keys})
    ↓
bridge.js (ISOLATED) → chrome.runtime.sendMessage({type: 'download', url, drm_keys})
    ↓
background.js (SERVICE WORKER) → fetch('http://localhost:8000/api/download', ...)
```

## R5: Per-Tab Interception Buffer

**Decision**: Maintain a `Map<tabId, {manifestUrl, drmKeys, dispatched}>` in the
service worker. Content scripts send partial data (manifest URL or DRM keys) as
they capture it. The service worker merges data per tab and dispatches only when
both pieces are present (for DRM) or immediately (for non-DRM `.m3u8`).

**Rationale**: The manifest URL and DRM keys may arrive in either order. A per-tab
buffer ensures we wait for both before dispatching. The service worker is the right
place for this state because it persists across content script injections within
the same tab.

**Alternatives considered**:
- Buffering in the MAIN-world script: Would lose state on page navigation. The
  MAIN script runs per-frame and can be garbage collected.
- Buffering in the bridge script: Same issue — content scripts are tied to page
  lifecycle.

**Cleanup**: Use `chrome.tabs.onRemoved` and `chrome.tabs.onUpdated` (with
`changeInfo.status === 'loading'`) to clear buffer entries when a tab closes or
navigates away.

## R6: Chrome Notifications

**Decision**: Use `chrome.notifications.create()` in the service worker with
`type: "basic"` for success/failure notifications.

**Rationale**: Simple, built-in, no popup UI needed. Requires `"notifications"`
permission in `manifest.json`.

**Key payloads**:
```javascript
// Success
chrome.notifications.create({
  type: 'basic',
  iconUrl: 'icons/icon48.png',
  title: 'UHDD: Download Queued',
  message: `Manifest: ${url}`
});

// Failure
chrome.notifications.create({
  type: 'basic',
  iconUrl: 'icons/icon48.png',
  title: 'UHDD: Backend Offline',
  message: 'Could not reach the UHDD daemon at localhost:8000'
});
```

## R7: Deduplication Strategy

**Decision**: Maintain a `Set<string>` per tab in the service worker containing
dispatched manifest URLs. Before dispatching, check if the URL is already in the
set. Clear the set on tab navigation or close.

**Rationale**: Some players re-request the same manifest during quality switches
or seeks. Deduplication prevents redundant downloads.

## R8: Manifest V3 Permissions

**Decision**: Request minimal permissions:
- `"notifications"` — for Chrome notifications
- `"host_permissions": ["*://*/*", "http://localhost:8000/*"]` — for content script
  injection on all sites and daemon communication from the service worker

**Rationale**: `"activeTab"` alone is insufficient because the extension needs to
inject content scripts on every page automatically (not just on user action).
The `"scripting"` permission is only needed for programmatic injection, which we
avoid by using manifest-declared content scripts.

**Note**: The user specified `"scripting"` and `"activeTab"` in the spec, but these
are not needed with manifest-declared content scripts + `"world": "MAIN"`. We use
only `"notifications"` as an API permission, plus broad `host_permissions`.
