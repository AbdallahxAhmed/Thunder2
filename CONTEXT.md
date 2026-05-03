# Domain Glossary

> Canonical terms used across Dark Downloader specs, code, and discussions.
> If a term isn't here, it isn't agreed upon yet.

| Term | Definition |
|---|---|
| **UHDD** | Unified Headless Download Daemon. The Python/FastAPI backend that orchestrates downloads across engines. |
| **Engine** | A download backend: `aria2` (direct files), `ytdlp` (media sites), `m3u8` (DRM/N_m3u8DL-RE). Exhaustive set per constitution. |
| **Pill** | The compact, rectangular IDM-style download button anchored to a `<video>` element. Replaces the legacy circular floating button (FAB). |
| **Morphing** | The animated transition where a Pill expands in-place into a format selection Menu, and collapses back when dismissed. |
| **STATE_PILL** | UI state: compact pill visible. Dragging enabled. |
| **STATE_MENU** | UI state: pill has expanded into format list. Dragging disabled, scrolling enabled. |
| **Hybrid Data Pipeline** | Architecture where `content.js` fetches ALL stream data (RAW intercepts + yt-dlp formats) via `background.js` proxy using `GET_HYBRID_STREAMS`. Content script never calls the daemon directly. |
| **Dumb UI / Smart Interceptor** | Pattern: content script is a "dumb" renderer; background script handles all daemon communication, bypassing CSP. |
| **Ghost Overlay** | The fixed-position, pointer-events-none host element (`#uhdd-host`) that escapes host page stacking contexts. Internal elements use `pointer-events: auto`. |
| **RAW Stream** | An intercepted M3U8/MPD manifest URL captured by `eme_hook.js`. Displayed as "🎬 Master Stream (Adaptive)" with a RAW badge. |
| **Tab Buffer** | Per-tab data structure in `background.js` (`tabBuffers` Map) accumulating manifest URL + DRM metadata until dispatch. |
| **Format Cache** | Per-tab cache in `background.js` (`formatCache` Map) storing yt-dlp format results with 5-minute TTL. |
