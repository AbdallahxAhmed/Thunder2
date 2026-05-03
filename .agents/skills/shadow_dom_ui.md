# Skill: Shadow DOM Floating UI & Draggable Architecture

This skill dictates how to inject a premium, completely isolated floating UI into hostile web pages (like Dailymotion or YouTube) without CSS conflicts or Event Hijacking.

## Architecture Rules:
1. **Absolute Isolation (Shadow DOM):** You MUST create a host element (e.g., `<div id="uhdd-host"></div>`) and attach a Shadow DOM to it (`attachShadow({mode: 'closed'})` or `open`). ALL UI elements and CSS must live inside this shadow root.
2. **Top-Level Enforcement:** To prevent iframe spam (Dailymotion bug), you MUST wrap the entire injection logic in `if (window !== window.top) return;`. The UI only lives in the main document.
3. **Vanilla JS Dragging:** Drag logic (`mousedown`, `mousemove`, `mouseup`) must be bound inside the shadow root or carefully on the top document to prevent host sites from hijacking `pointer-events`. Use strict coordinate math to differentiate a click (< 5px movement) from a drag.
4. **CSS Protection:** The host container gets `position: fixed !important; z-index: 2147483647 !important;`. The internal UI gets standard styling isolated by the shadow boundary.
5. **Data Flow:** The button inside the shadow DOM communicates via `chrome.runtime.sendMessage` to fetch data from the background script.