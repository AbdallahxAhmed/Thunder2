# Quickstart: UHDD Browser Interceptor (MV3 Extension)

## Prerequisites

- **Chrome 102+** (or any Chromium-based browser: Edge, Brave, Vivaldi)
- **UHDD daemon** running locally on `http://localhost:8000` (see `specs/001-uhdd-download-daemon/quickstart.md`)

## Install the Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `extension/` directory from this project
5. The extension should appear in the list with no errors

## Verify Installation

- The extension should show in `chrome://extensions/` with status "Enabled"
- No errors should appear in the extension's service worker console
  (click "Inspect views: service worker" to check)

## Test: DRM Stream Interception (User Story 1)

1. Ensure the UHDD daemon is running:
   ```bash
   uvicorn src.main:app --host 0.0.0.0 --port 8000
   ```
2. Navigate to a Widevine-encrypted DASH player (e.g., a test page serving `.mpd` content)
3. Wait for the video to begin playing
4. **Expected**: A Chrome notification appears with "UHDD: Download Queued"
5. **Verify**: Check the daemon logs — a new job should appear with `engine: m3u8`

## Test: Non-DRM HLS Interception (User Story 3)

1. Navigate to a page with an HLS stream (`.m3u8`)
2. **Expected**: A Chrome notification appears with "UHDD: Download Queued"
3. **Verify**: The daemon job should show `engine: ytdlp` (no DRM keys)

## Test: Backend Offline Notification (User Story 2)

1. Stop the UHDD daemon
2. Navigate to a page with a `.mpd` or `.m3u8` stream
3. **Expected**: A Chrome notification appears with "UHDD: Backend Offline"

## Test: Deduplication (Edge Case)

1. Navigate to a DRM-protected page
2. After the first notification, seek or switch quality in the video
3. **Expected**: No second notification — the manifest URL was already dispatched

## Test: Tab Navigation Cleanup (Edge Case)

1. Navigate to a DRM-protected page (notification fires)
2. Navigate to a different site in the same tab
3. Navigate back to the streaming page
4. **Expected**: A new notification fires — the previous buffer was cleared on navigation

## Directory Layout

```
extension/
├── manifest.json                    # MV3 manifest
├── background.js                    # Service worker
├── content_scripts/
│   ├── eme_hook.js                  # MAIN world EME/network hook
│   └── bridge.js                    # Isolated world message relay
└── icons/
    ├── icon16.png                   # Toolbar icon
    ├── icon48.png                   # Extensions page icon
    └── icon128.png                  # Chrome Web Store icon
```

## Debugging

- **Service worker logs**: `chrome://extensions/` → click "Inspect views: service worker"
- **Content script logs**: Open DevTools on the target page → Console tab → filter by extension
- **MAIN world logs**: Visible directly in the page's console (same execution context)
