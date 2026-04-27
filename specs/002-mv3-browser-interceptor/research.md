# Research: Native Download Hijacker

**Date**: 2026-04-27
**Feature**: v3 — Native Download Hijacker

## R1: `chrome.downloads.onCreated` API Behavior

**Decision**: Use `chrome.downloads.onCreated` as the sole interception point for native downloads.

**Rationale**: The `onCreated` event fires synchronously when Chrome starts a download, providing the `DownloadItem` object with `url`, `referrer`, `filename`, `mime`, and `id`. This is the earliest point to intercept and cancel a download via `chrome.downloads.cancel(downloadId)`. The alternative `chrome.downloads.onDeterminingFilename` only fires for filename decisions and cannot prevent the download.

**Alternatives considered**:
- `chrome.webRequest.onBeforeRequest` — Cannot distinguish download navigations from regular page loads. Also, MV3 declarativeNetRequest does not support programmatic blocking of downloads.
- `chrome.downloads.onDeterminingFilename` — Too late; the download has already started transferring.

## R2: Anti-Loop Guard Strategy

**Decision**: Two-layer guard: (1) URL hostname check against `localhost`/`127.0.0.1`, and (2) a `Set<string>` of recently dispatched URLs that are expected to be downloaded by aria2 (not relevant here since aria2 downloads externally, but guards against edge cases).

**Rationale**: aria2 downloads files directly via its own HTTP client, so Chrome never sees those transfers. The primary loop risk is if the extension itself triggers a Chrome download (e.g., via `chrome.downloads.download()`). The localhost check catches daemon-served files. The URL set catches any programmatic download the extension might trigger.

**Alternatives considered**:
- Cookie-based tagging — Too fragile, cookies may be stripped.
- Custom header injection — MV3 service workers can't modify download request headers via `chrome.downloads`.

## R3: Cookie Extraction via `chrome.cookies.getAll()`

**Decision**: Use `chrome.cookies.getAll({ url: downloadUrl })` to retrieve all cookies for the download domain, then serialize them as `name=value; name2=value2` for the daemon payload.

**Rationale**: The `chrome.downloads.onCreated` `DownloadItem` does not include cookies. The `chrome.cookies` API requires `host_permissions` for the target domain — the extension already has `*://*/*`, which grants access to all domains.

**Alternatives considered**:
- `chrome.cookies` permission — Not required when `host_permissions: *://*/*` is already declared.
- Reading `document.cookie` via content script — Misses HttpOnly cookies and requires a content script injection into the download tab.

## R4: Referer Extraction

**Decision**: Extract the Referer from `downloadItem.referrer` (available on the `DownloadItem` object in `onCreated`). Fallback: query the active tab URL via `chrome.tabs.get(downloadItem.tabId)`.

**Rationale**: The `DownloadItem.referrer` field is the most reliable source. If it is empty or undefined (rare), the tab URL serves as a reasonable proxy.

**Alternatives considered**:
- Injecting a content script to read `document.referrer` — Extra complexity for marginal benefit.

## R5: Engine Override in Daemon Router

**Decision**: Add an optional `engine` field to `DownloadRequest`. When present, the `classify()` function is bypassed entirely, and the specified engine is used directly.

**Rationale**: The download hijacker always wants aria2 — it should not rely on URL pattern matching, which could misroute URLs. An explicit engine override is the simplest, most deterministic approach.

**Alternatives considered**:
- Adding a separate endpoint (e.g., `POST /api/aria2`) — Violates the single-endpoint design; fragments the API surface.
- Adding URL patterns for "generic file" extensions — Brittle; can't anticipate all file types.

## R6: Graceful Fallback When Daemon is Offline

**Decision**: The extension should NOT cancel the Chrome download until the daemon confirms acceptance (HTTP 2xx). If the daemon is unreachable (fetch fails / non-2xx), the native download proceeds normally and the user is notified via Chrome notification.

**Rationale**: Cancelling first and then discovering the daemon is offline would lose the download entirely. The "dispatch-then-cancel" order ensures zero data loss.

**Alternatives considered**:
- Pre-check daemon health via `GET /api/health` — Adds latency and a race condition (daemon could go offline between health check and dispatch).
- Always cancel and queue for retry — Too aggressive; user loses immediate download capability.
