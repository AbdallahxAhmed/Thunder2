# Message Contracts: UHDD Browser Interceptor

**Date**: 2026-04-26
**Purpose**: Define the exact shape of every message exchanged between extension components.

## 1. Custom DOM Event: `uhdd_payload_ready`

**Direction**: `eme_hook.js` (MAIN world) → `bridge.js` (Isolated world)
**Mechanism**: `window.dispatchEvent(new CustomEvent(...))`

### Manifest Captured

```javascript
window.dispatchEvent(new CustomEvent('uhdd_payload_ready', {
  detail: {
    type: 'manifest',
    url: 'https://cdn.example.com/video/stream.mpd'
  }
}));
```

### DRM Keys Captured

```javascript
window.dispatchEvent(new CustomEvent('uhdd_payload_ready', {
  detail: {
    type: 'drm_keys',
    drmKeys: 'abcdef1234567890abcdef1234567890:fedcba0987654321fedcba0987654321'
  }
}));
```

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `type` | `string` | `"manifest"` \| `"drm_keys"` | Identifies what was captured |
| `url` | `string` | Any URL | Present only when `type === "manifest"` |
| `drmKeys` | `string` | `KID:KEY` hex | Present only when `type === "drm_keys"` |

---

## 2. Chrome Runtime Message

**Direction**: `bridge.js` (Isolated world) → `background.js` (Service Worker)
**Mechanism**: `chrome.runtime.sendMessage({...})`

### Manifest Message

```javascript
chrome.runtime.sendMessage({
  type: 'manifest_captured',
  url: 'https://cdn.example.com/video/stream.mpd'
});
```

### DRM Keys Message

```javascript
chrome.runtime.sendMessage({
  type: 'drm_keys_captured',
  drmKeys: 'abcdef1234567890abcdef1234567890:fedcba0987654321fedcba0987654321'
});
```

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `type` | `string` | `"manifest_captured"` \| `"drm_keys_captured"` | Message discriminator |
| `url` | `string` | Any URL | Present only for `manifest_captured` |
| `drmKeys` | `string` | `KID:KEY` hex | Present only for `drm_keys_captured` |

---

## 3. UHDD Daemon Request

**Direction**: `background.js` (Service Worker) → UHDD daemon
**Mechanism**: `fetch('http://localhost:8000/api/download', ...)`
**Method**: `POST`
**Content-Type**: `application/json`

### DRM Download

```json
{
  "url": "https://cdn.example.com/video/stream.mpd",
  "drm_keys": "abcdef1234567890abcdef1234567890:fedcba0987654321fedcba0987654321"
}
```

### Non-DRM Download (m3u8)

```json
{
  "url": "https://cdn.example.com/live/stream.m3u8"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | `string` | Yes | Manifest URL |
| `drm_keys` | `string` | No | Omitted for non-DRM streams |

### Expected Responses

**202 Accepted** (success):
```json
{"id": "uuid", "status": "queued", "engine": "m3u8"}
```

**503 Service Unavailable** (engine down):
```json
{"error_code": "ENGINE_UNAVAILABLE", "message": "..."}
```

---

## 4. Chrome Notification Payloads

**Direction**: `background.js` → Chrome Notifications API

### Success

```javascript
chrome.notifications.create({
  type: 'basic',
  iconUrl: 'icons/icon48.png',
  title: 'UHDD: Download Queued',
  message: 'stream.mpd → m3u8 engine'
});
```

### Failure

```javascript
chrome.notifications.create({
  type: 'basic',
  iconUrl: 'icons/icon48.png',
  title: 'UHDD: Backend Offline',
  message: 'Could not reach UHDD daemon at localhost:8000'
});
```
