# Dark Downloader (Unified Headless Download Daemon - UHDD)

Dark Downloader is a professional, advanced headless media management and download acceleration system. It consists of a high-performance Python daemon backend and an intelligent MV3 Chrome Extension that completely takes over the browser's native downloading and streaming experience.

## Core Architecture

The project is split into two primary components that communicate seamlessly:

1. **UHDD Daemon (Backend)**: A FastAPI-based Python server running locally (`localhost:8000`). It orchestrates multiple powerful download engines (`yt-dlp`, `aria2`, `N_m3u8DL-RE`, and `pywidevine`) to handle everything from simple file transfers to complex DRM decryption.
2. **Browser Interceptor (Extension)**: An MV3 Chrome Extension that hooks into the browser's execution context, intercepts native downloads, extracts DRM keys, and injects context-aware UI elements directly into media players.

---

## What the Project Currently Provides

### 1. The License Proxy Architecture (DRM Interception)
Dark Downloader can seamlessly download Widevine DRM-protected video streams.
- **How it works**: The extension hooks into the browser's EME (Encrypted Media Extensions) API. When a video player attempts to negotiate a DRM license, the extension intercepts the Manifest URL (`.mpd`), the PSSH (Protection System Specific Header), the License Server URL, and all custom HTTP Request Headers.
- **Server-Side Decryption**: The extension forwards this data to the UHDD Daemon. The daemon uses `pywidevine` and a local `.wvd` (Widevine Device) file to negotiate with the license server directly, extracting the plaintext `KID:KEY` pairs.
- **Muxing**: The keys and manifest are passed to `N_m3u8DL-RE`, which downloads the encrypted segments, decrypts them on the fly, and muxes them into a playable `.mp4` file.

### 2. The Native Download Hijacker
Chrome's built-in download manager is single-threaded and slow. UHDD replaces it entirely.
- **How it works**: The extension listens to `chrome.downloads.onCreated`. The moment a user clicks a direct download link (PDF, ZIP, ISO, EXE), the extension instantly cancels Chrome's native download.
- **Context Preservation**: It extracts the exact URL, the originating tab's `Referer`, the `User-Agent`, and the site's `Cookies`.
- **Aria2 Acceleration**: The context is dispatched to the daemon and handed off to `aria2c`. `aria2` uses multi-connection segmented downloading to fetch the file at maximum bandwidth, completely bypassing Chrome's limitations. An Anti-Loop Guard prevents infinite recursion.

### 3. The Ghost Overlay Tracking System
A professional, zero-jank floating UI injected directly over web video players.
- **Root-Level Shadow DOM**: The extension injects a transparent host element directly into the `document.documentElement` to bypass aggressive CSS stacking traps and `overflow: hidden` rules on hostile sites (like Dailymotion). The UI lives inside a closed Shadow DOM, making it 100% immune to site stylesheets.
- **Anti-Jank Tracking**: Instead of manual drag-and-drop, the UI uses `getBoundingClientRect()` coupled with a `ResizeObserver`, an `IntersectionObserver`, and throttled `scroll`/`resize` events (`requestAnimationFrame`) to automatically and perfectly anchor a download button to the top-right corner of the active `<video>` element.
- **Dynamic DOM Handling**: A `MutationObserver` watches the document body. If a site (like YouTube) destroys and recreates the video element during an ad break, the tracking system automatically latches onto the new video player.

### 4. Zero-Latency Quality Picker Popup
An instantaneous, premium extension popup for manual quality selection.
- **Pre-fetching Cache**: The extension's service worker aggressively caches format data. When the user clicks the extension icon, the UI loads instantly without any loading spinners.
- **Smart Formatting**: Video formats are parsed and displayed with intelligent resolution badges (4K, QHD, HD, SD), grouping video options separately from audio-only options.

## Quick Start (Development)

1. **Start the Daemon**:
   ```bash
   uvicorn src.main:app --host 0.0.0.0 --port 8000
   ```
2. **Load the Extension**:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked" and select the `extension/` directory.

## Dependencies

- **Python**: `FastAPI`, `uvicorn`, `pywidevine`, `yt-dlp`
- **Binaries**: `aria2c`, `N_m3u8DL-RE`, `ffmpeg` (must be installed and available in PATH)
- **Browser**: Google Chrome 102+ (Manifest V3 support required)
