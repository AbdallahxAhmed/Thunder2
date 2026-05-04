# Quickstart: Quality Picker Popup

**Date**: 2026-04-27

## Prerequisites

1. Thunder daemon running: `uvicorn src.main:app --host 0.0.0.0 --port 8000`
2. Chrome 102+ with developer mode enabled
3. Extension loaded from `extension/` directory

## Testing the Format Discovery Endpoint

### 1. Test via curl

```bash
# Query formats for a YouTube video
curl -s "http://localhost:8000/api/info?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DdQw4w9WgXcQ" | python3 -m json.tool

# Expected: JSON with video_formats and audio_formats arrays
```

### 2. Test format-specific download

```bash
# Download a specific format (720p video + medium audio)
curl -X POST http://localhost:8000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "engine": "ytdlp", "format_id": "136+140"}'

# Expected: 202 response with job ID
```

### 3. Test error handling

```bash
# Invalid URL
curl -s "http://localhost:8000/api/info?url=https%3A%2F%2Fexample.com" | python3 -m json.tool

# Expected: 422 with extraction error
```

## Testing the Popup

### 1. Load the extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `extension/` directory
4. If already loaded, click the refresh icon to reload

### 2. Test format display

1. Navigate to a YouTube video
2. Click the Thunder extension icon in the toolbar
3. **Expected**: Loading spinner → format list appears with video and audio sections
4. Verify: Video formats show resolution, codec, and file size
5. Verify: Audio formats show codec and bitrate

### 3. Test download dispatch

1. With formats displayed, click a format button
2. **Expected**: Success state with green checkmark
3. Verify: Daemon logs show a download started with the selected format_id

### 4. Test error states

1. Navigate to google.com → click icon → **Expected**: "No downloadable media" message
2. Stop daemon → navigate to YouTube → click icon → **Expected**: "Backend offline" message

## Validation Checklist

- [ ] `GET /api/info` returns formats for YouTube URLs
- [ ] `GET /api/info` returns 422 for unsupported URLs
- [ ] `POST /api/download` with `format_id` downloads correct quality
- [ ] Popup shows loading state on open
- [ ] Popup shows format list for media pages
- [ ] Popup shows "no media" for non-media pages
- [ ] Popup shows "backend offline" when daemon is down
- [ ] Popup shows success after dispatching a download
- [ ] Dark theme renders correctly (no white flashes)
- [ ] Hover transitions work on format buttons
