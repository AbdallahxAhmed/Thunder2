# Data Model: UHDD Browser Interceptor (MV3 Extension)

**Date**: 2026-04-26
**Source**: [spec.md](spec.md) + [research.md](research.md)

## Entities

### InterceptionBuffer (per-tab state in service worker)

Tracks partially-captured data for each browser tab until a complete payload
can be dispatched.

| Field | Type | Description |
|-------|------|-------------|
| `tabId` | `number` | Chrome tab ID (unique key) |
| `manifestUrl` | `string \| null` | Captured `.mpd` or `.m3u8` URL |
| `drmKeys` | `string \| null` | Captured `KID:KEY` hex pair |
| `dispatchedUrls` | `Set<string>` | URLs already sent to daemon (dedup) |

**State transitions**:
```
empty → manifestUrl captured → both captured → dispatched
empty → drmKeys captured → both captured → dispatched
```

Dispatch trigger: `manifestUrl != null && drmKeys != null` (for DRM streams)
or `manifestUrl != null && manifestUrl ends with .m3u8` (for non-DRM streams).

**Cleanup**: Entry is deleted when:
- Tab is closed (`chrome.tabs.onRemoved`)
- Tab navigates to a new page (`chrome.tabs.onUpdated` with `status === 'loading'`)

### DownloadPayload (sent to UHDD daemon)

The JSON object dispatched from the service worker to the daemon.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Manifest URL (`.mpd` or `.m3u8`) |
| `drm_keys` | `string \| undefined` | No | `KID:KEY` hex pair. Omitted for non-DRM streams. |

### InternalMessage (content script → service worker)

Messages passed through the bridge layer via `chrome.runtime.sendMessage`.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | Message type: `"manifest_captured"` or `"drm_keys_captured"` |
| `url` | `string \| undefined` | Manifest URL (only for `manifest_captured`) |
| `drmKeys` | `string \| undefined` | `KID:KEY` pair (only for `drm_keys_captured`) |

### CustomEvent Payload (MAIN → bridge via DOM event)

Data attached to the `uhdd_payload_ready` custom event.

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `"manifest"` or `"drm_keys"` |
| `url` | `string \| undefined` | Manifest URL |
| `drmKeys` | `string \| undefined` | `KID:KEY` pair |

## Relationships

```
eme_hook.js (MAIN) ──dispatches──▶ CustomEvent('uhdd_payload_ready')
    ↓
bridge.js (ISOLATED) ──sends──▶ InternalMessage via chrome.runtime.sendMessage
    ↓
background.js (SW) ──merges into──▶ InterceptionBuffer[tabId]
    ↓ (when complete)
background.js (SW) ──POSTs──▶ DownloadPayload to localhost:8000/api/download
    ↓ (on response)
background.js (SW) ──creates──▶ Chrome Notification (success or failure)
```
