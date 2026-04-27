# Data Model: Quality Picker Popup

**Date**: 2026-04-27

## Daemon-Side Models

### FormatInfo (new response model)

Represents a single downloadable format returned by yt-dlp.

| Field         | Type              | Required | Description                                          |
|---------------|-------------------|----------|------------------------------------------------------|
| `format_id`   | `str`             | Yes      | yt-dlp format identifier (e.g., `"137"`, `"140"`)   |
| `ext`         | `str`             | Yes      | File extension (e.g., `"mp4"`, `"webm"`, `"m4a"`)   |
| `resolution`  | `Optional[str]`   | No       | Resolution string (e.g., `"1920x1080"`, `"audio only"`) |
| `vcodec`      | `Optional[str]`   | No       | Video codec (e.g., `"avc1"`, `"vp9"`, `"none"`)     |
| `acodec`      | `Optional[str]`   | No       | Audio codec (e.g., `"mp4a"`, `"opus"`, `"none"`)     |
| `filesize`    | `Optional[int]`   | No       | File size in bytes (exact or approximate)             |
| `format_note` | `Optional[str]`   | No       | Human-readable note (e.g., `"1080p"`, `"medium"`)    |
| `fps`         | `Optional[float]` | No       | Frames per second                                     |
| `tbr`         | `Optional[float]` | No       | Total bitrate in kbps                                 |
| `type`        | `str`             | Yes      | `"video"` or `"audio"`                                |

### InfoResponse (new response model)

Response body for `GET /api/info`.

| Field           | Type                 | Required | Description                                   |
|-----------------|----------------------|----------|-----------------------------------------------|
| `url`           | `str`                | Yes      | The queried media URL                         |
| `title`         | `Optional[str]`      | No       | Media title from yt-dlp                       |
| `thumbnail`     | `Optional[str]`      | No       | Thumbnail URL                                 |
| `duration`      | `Optional[float]`    | No       | Duration in seconds                           |
| `video_formats` | `list[FormatInfo]`   | Yes      | Video formats sorted by quality descending    |
| `audio_formats` | `list[FormatInfo]`   | Yes      | Audio-only formats sorted by bitrate descending |

### DownloadRequest (updated — new field)

New optional field added to existing `DownloadRequest`:

| Field       | Type             | Default | Description                                              |
|-------------|------------------|---------|----------------------------------------------------------|
| `format_id` | `Optional[str]`  | `None`  | yt-dlp format ID for quality selection (e.g., `"137+140"`) |

Existing fields remain unchanged.

## Extension-Side Data

### Popup State Machine

```text
                  ┌──────────────┐
     Tab URL      │              │
   ─────────────► │   LOADING    │
                  │  (spinner)   │
                  └──────┬───────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
            ▼            ▼            ▼
     ┌──────────┐ ┌──────────┐ ┌──────────┐
     │  LOADED  │ │  ERROR   │ │  ERROR   │
     │ (formats)│ │(no media)│ │(offline) │
     └────┬─────┘ └──────────┘ └──────────┘
          │
          │ click format
          ▼
     ┌──────────┐
     │ SUCCESS  │
     │(queued ✓)│
     └──────────┘
```

### Known Media Domains (popup-side)

The popup hardcodes a domain list matching the daemon's `KNOWN_MEDIA_DOMAINS` from `router.py`:

```javascript
const KNOWN_MEDIA_DOMAINS = new Set([
  "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com",
  "music.youtube.com", "twitter.com", "www.twitter.com",
  "x.com", "www.x.com", "vimeo.com", "www.vimeo.com",
  "dailymotion.com", "www.dailymotion.com", "twitch.tv",
  "www.twitch.tv", "clips.twitch.tv", "tiktok.com",
  "www.tiktok.com", "instagram.com", "www.instagram.com",
  "soundcloud.com", "www.soundcloud.com", "reddit.com",
  "www.reddit.com", "v.redd.it", "facebook.com",
  "www.facebook.com", "fb.watch",
]);
```

## Data Flow

```text
User clicks extension icon
  │
  ▼
popup.js (DOMContentLoaded)
  │ chrome.tabs.query({active: true})
  ▼
  Check tab.url domain ∈ KNOWN_MEDIA_DOMAINS?
  │
  ├─ NO → Show "No downloadable media" error state
  │
  └─ YES → fetch GET /api/info?url=<encoded>
              │
              ▼
         main.py → ytdlp_client.extract_info(url)
              │ yt_dlp.YoutubeDL().extract_info(url, download=False)
              │
              ▼
         Return InfoResponse { video_formats, audio_formats }
              │
              ▼
         popup.js renders format buttons
              │
              ▼ user clicks format
              │
         fetch POST /api/download
           { url, engine: "ytdlp", format_id: "137+140" }
              │
              ▼
         main.py → submit_download()
           request.engine = "ytdlp" → skip classify()
           ytdlp_client.execute(job, request)
              │ _build_opts → format = request.format_id
              │
              ▼
         yt_dlp.YoutubeDL(opts).download([url])
```
