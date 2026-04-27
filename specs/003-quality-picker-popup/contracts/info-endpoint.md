# Contract: GET /api/info — Quality-Obsessed Format Discovery (v3)

**Date**: 2026-04-27 (revised v3 — Pro-Level)
**Feature**: Quality Picker Popup

## Endpoint

```
GET /api/info?url={encoded_url}
```

## Request

| Parameter | Location | Type   | Required | Description                   |
|-----------|----------|--------|----------|-------------------------------|
| `url`     | Query    | string | Yes      | URL-encoded media page URL    |

## Success Response (200 OK)

Returns a curated, dynamic resolution ladder based on what the source
actually supports.  Each `format_id` uses `bestvideo[height<=H]+bestaudio/best`
to guarantee merged audio+video.  The `badge` field provides UI hints.

```json
{
  "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "title": "Rick Astley - Never Gonna Give You Up",
  "thumbnail": "https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg",
  "duration": 212.0,
  "max_height": 1080,
  "options": [
    { "label": "Best Quality (Original)", "format_id": "bestvideo+bestaudio/best", "type": "video", "badge": "HD" },
    { "label": "1080p", "format_id": "bestvideo[height<=1080]+bestaudio/best", "type": "video", "badge": "HD" },
    { "label": "720p",  "format_id": "bestvideo[height<=720]+bestaudio/best",  "type": "video", "badge": "HQ" },
    { "label": "480p",  "format_id": "bestvideo[height<=480]+bestaudio/best",  "type": "video", "badge": null },
    { "label": "360p",  "format_id": "bestvideo[height<=360]+bestaudio/best",  "type": "video", "badge": null },
    { "label": "240p",  "format_id": "bestvideo[height<=240]+bestaudio/best",  "type": "video", "badge": null },
    { "label": "144p",  "format_id": "bestvideo[height<=144]+bestaudio/best",  "type": "video", "badge": null },
    { "label": "Audio Only (best)", "format_id": "bestaudio/best", "type": "audio", "badge": null }
  ]
}
```

### Resolution Ladder Rules

| Tier | Label | Badge | Condition |
|------|-------|-------|-----------|
| Best | Best Quality (Original) | 4K/HD/null | Always present; badge reflects max_height |
| 2160p | 4K (2160p) | `4K` | Only if max_height ≥ 2160 |
| 1440p | 1440p | `QHD` | Only if max_height ≥ 1440 |
| 1080p | 1080p | `HD` | Only if max_height ≥ 1080 |
| 720p | 720p | `HD` or `HQ` | Only if max_height ≥ 720; `HQ` if vp9/av01 available |
| 480p | 480p | null | Only if max_height ≥ 480 |
| 360p | 360p | null | Only if max_height ≥ 360 |
| 240p | 240p | null | Only if max_height ≥ 240 |
| 144p | 144p | null | Only if max_height ≥ 144 |
| Audio | Audio Only (best) | null | Always present |

### Badge Logic

- `4K` — gold pill, indicates 4K/UHD content
- `QHD` — cyan pill, indicates 1440p content
- `HD` — indigo pill, indicates 720p+ content
- `HQ` — cyan pill, indicates superior codec (vp9/av01) available at this tier

## Pre-Fetch Architecture

The extension service worker **automatically pre-fetches** format info
when a supported media site finishes loading (`chrome.tabs.onUpdated`
with `status === "complete"`).  The result is cached in a `Map` keyed
by `tabId`.

- **Cache TTL**: 5 minutes
- **Invalidation**: On tab navigation (`status === "loading"`) or tab close
- **Popup behavior**: If cache is warm → instant render (no spinner).
  If cache is cold → shows spinner while background fetches.

## Error Responses

### 422 — Invalid or Unsupported URL

```json
{
  "error_code": "EXTRACTION_ERROR",
  "message": "yt-dlp could not extract info from this URL",
  "details": []
}
```

### 503 — Engine Unavailable

```json
{
  "error_code": "ENGINE_UNAVAILABLE",
  "message": "ytdlp engine is not available",
  "details": []
}
```
