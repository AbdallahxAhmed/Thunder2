# Skill: UHDD Floating UI Architecture (The "Dumb Ghost" Pattern)

This skill dictates how to build the floating download button (`content.js` & `content.css`) for the UHDD Extension. You MUST adhere to these architectural pillars to bypass hostile site protections (like YouTube/Dailymotion):

## 1. UI Encapsulation (Shadow DOM)
- You MUST create a host element (e.g., `<div id="uhdd-host">`) and attach a Shadow Root (`mode: 'closed'`).
- ALL UI elements and CSS must live inside this shadow boundary to prevent CSS leakage and Z-index wars.
- Inject CSS into the Shadow Root using `<link rel="stylesheet" href="chrome-extension://.../content.css">`. Ensure `content.css` is in `web_accessible_resources` in `manifest.json`.

## 2. Smart Lazy Injection (No Iframe Spam)
- DO NOT use `if (window !== window.top) return;` (it breaks on embedded players).
- Allow the script to run in all frames, but ONLY inject the Shadow DOM if a `<video>` tag is physically detected by a `MutationObserver` in that specific frame.

## 3. Interaction & Positioning (The Draggable Ghost)
- Drag logic must use pure JS absolute positioning (`style.left`, `style.top`) based on offsets from the video element. 
- DO NOT use CSS variables (`--btn-x`, `--btn-y`) for positioning, as they conflict with pseudo-classes like `:active`.
- Distinguish between a drag and a click using Euclidean distance (`Math.hypot(dx, dy) < 5` is a click).
- Bind `mousemove` and `mouseup` to the `document` to prevent event hijacking when the cursor leaves the button.

## 4. Data Flow (Dumb UI / Smart Interceptor)
- The Floating Button is a DUMB UI. 
- `content.js` MUST NOT make direct `fetch()` calls to the local Python daemon. This triggers CSP errors.
- **Fetching:** Send a message to `background.js` (`action: "GET_TAB_STREAMS"`) to get cached formats instantly.
- **Downloading:** Send a message to `background.js` (`action: "TRIGGER_DOWNLOAD"`) and let the Service Worker execute the `POST` request to the daemon.