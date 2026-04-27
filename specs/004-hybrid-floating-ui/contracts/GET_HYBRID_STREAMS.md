# Contract: GET_HYBRID_STREAMS

**Role**: Browser Extension Internal API (Content Script ↔ Background Script)

**Action**: `GET_HYBRID_STREAMS`

**Purpose**: Fetches the unified list of download options, combining intercepted M3U8 streams with explicit yt-dlp formats.

## Request Payload

```json
{
  "action": "GET_HYBRID_STREAMS",
  "url": "https://example.com/video/123",
  "tabId": 45 // (Optional) Usually derived from sender context in background.js
}
```

## Response Payload (Success)

```json
{
  "ok": true,
  "data": {
    "title": "Example Video Title",
    "url": "https://example.com/video/123",
    "options": [
      {
        "type": "video",
        "format_id": "raw-m3u8",
        "label": "🎬 Master Stream (Adaptive)",
        "badge": "RAW",
        "resolution": null,
        "vcodec": "unknown",
        "acodec": "unknown",
        "ext": "m3u8"
      },
      {
        "type": "video",
        "format_id": "137+140",
        "label": "1080p MP4",
        "badge": "HD",
        "resolution": "1920x1080",
        "vcodec": "avc1",
        "acodec": "mp4a",
        "ext": "mp4"
      }
    ]
  },
  "fromCache": true
}
```

## Response Payload (Error)

```json
{
  "ok": false,
  "error": "Timeout waiting for formats"
}
```
