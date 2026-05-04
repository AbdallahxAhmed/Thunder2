---
name: youtube-downloader-mastery
description: Edge cases and architecture rules for building a bulletproof YouTube downloader extension with yt-dlp backend.
---

# YouTube Downloader Mastery

## 1. DOM-Driven Extension Init

**Never** use `window.onload`, `DOMContentLoaded`, or naive URL-polling intervals to bootstrap a content script on YouTube (or any SPA).

### Rules

- The content script MUST remain **fully dormant** (no observers, no intervals, no message dispatches) until it explicitly detects a `<video>` element in its own `document`.
- Use capture-phase event listeners (`play`, `playing`, `loadedmetadata`, `canplay`) on `document` to wake up.
- **Iframe Guard**: YouTube embeds hidden iframes (`ogs.google.com`, `accounts.google.com`, `consent.google.com`) that execute content scripts. Add a hostname blocklist at the **top** of the script to `throw` and abort execution in these contexts.
- **SPA Navigation**: Bind `yt-navigate-finish`, `pushState`/`replaceState` overrides, and `popstate` listeners **globally** (outside `wakeUp()`) so pre-warm signals fire instantly on navigation, even before the video element exists.
- **Pre-warm Decoupling**: The `PRE_WARM_URL` cache signal should fire on URL change. The Pill UI injection should fire on video element detection. These are independent lifecycles.

### URL Normalization

YouTube URLs accumulate junk params (`&t=10s`, `&feature=`, etc.) over time. Always normalize before caching:

```js
function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  const v = url.searchParams.get("v");
  url.search = v ? `?v=${v}` : "";
  url.hash = "";
  return url.toString();
}
```

## 2. Age-Gate & JS Challenges Bypass (yt-dlp)

### Problem

YouTube age-gated videos require authentication AND JavaScript challenge solving (n-sig, sig). Standard `--cookies-from-browser` alone fails with `Requested format is not available`.

### Solution Stack (all required together)

```python
auth_opts = {
    "quiet": True,
    "cookiesfrombrowser": ("chromium",),  # or "firefox", "edge"
    "extractor_args": {
        "youtube": ["client=IOS,ANDROID_VR", "player_client=ios,android"]
    },
    "remote_components": ["ejs:github"],  # MUST be a list, NOT a string
}
```

### Critical Gotchas

1. **`remote_components` must be a list**: Passing `"ejs:github"` (string) causes yt-dlp to iterate character-by-character: `e, j, s, :, g, i, t, h, u, b`. Always use `["ejs:github"]`.
2. **`js_runtimes` expects a dict**: Passing `["node"]` (list) crashes with `Invalid js_runtimes format`. Don't set it — yt-dlp auto-detects Node.js from `$PATH`.
3. **IDE Debugger Interference**: If your IDE's JS debugger attaches to the `deno` or `node` subprocess spawned by yt-dlp's EJS solver, it will crash the solver due to sandbox constraints. Ensure the debugger is configured to ignore these subprocesses.
4. **Do NOT set `format` in `auth_opts` for extraction**: Setting `"format": "bestvideo+bestaudio/best"` pre-filters the format list, stripping all individual formats before the API can enumerate them for the Quality Picker UI. Only set `format` during the **download** phase.
5. **Client Priority**: `IOS` returns the most formats. `ANDROID_VR` bypasses age-gate. Use both together for maximum coverage.
6. **Note regarding Warnings**: Never set `{"no_warnings": True}` in `auth_opts` during development. It silently swallows JS challenge failures and EJS missing component errors, making debugging impossible.

## 3. Format Mapping & Deduplication

### Height Extraction

Mobile/HLS formats from IOS/ANDROID clients often have missing or non-standard `height` values.

```python
h = f.get("height")
if h is not None:
    try:
        h = int(h)
    except (ValueError, TypeError):
        h = None
# Fallback: parse from resolution (e.g. "1920x1080")
if not h:
    res = f.get("resolution") or ""
    if "x" in res:
        h = int(res.split("x")[-1])
```

### Filtering

- Skip `vcodec == "none"` (audio-only streams)
- Skip `vcodec == "mhtml"` (screenshot pseudo-formats)
- Accept `vcodec == ""` or `None` (mobile formats with implicit video codec)

### Deduplication UX

Group formats by `height`. For each height, select ONE format using this priority:

1. **Highest FPS** (60fps > 30fps)
2. **Codec tiebreak**: Prefer `avc1`/`h264` (MP4) over `vp9`/`av01` (WebM) for maximum hardware compatibility
3. **Highest bitrate** (`tbr`) as final tiebreak

### Label Format

```
{height}p{fps} ({EXT}) - ~{size}MB
```

Examples:

- `1080p60 (MP4) - ~55MB`
- `720p30 (MP4) - ~22MB`
- `480p30 (WEBM)` (size omitted if unavailable)

**Note**: `filesize` and `filesize_approx` are returned in Bytes. To avoid any Agent confusion, divide by `(1024 * 1024)` and round to 1 decimal place for the MB label.

### Audio Fallback

Always append one final option:

```python
QualityOption(
    label="Audio Only (M4A/MP3)",
    format_id="bestaudio/best",
    type="audio",
    badge="Audio",
)
```

## 4. Cache Architecture

### Background Service Worker (`formatCache`)

- Key by **normalized URL** (not `tabId`) — `tabId` is unreliable in SPA/frame-heavy environments.
- TTL: 5 minutes (`300_000ms`).
- States: `fetching` → `ready` | `error`.
- On cache MISS during `GET_HYBRID_STREAMS`, set status to `fetching` and poll at 100ms intervals to coalesce concurrent requests.

### Content Script Pre-warm

- Fire `PRE_WARM_URL` on every SPA navigation (not just on video detection).
- Guard against non-YouTube URLs: skip if `youtube.com` hostname but no `watch?v=` param.
