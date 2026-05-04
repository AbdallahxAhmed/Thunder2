# Implementation Plan: Floating UI Architecture Rewrite (Dumb Ghost)

**Branch**: `004-floating-ui-rewrite` | **Date**: 2026-04-27 | **Spec**: [spec.md](spec.md)

## Summary
This plan details the implementation of the "Dumb UI / Smart Interceptor" architecture for the Thunder browser extension. It involves a complete rewrite of `content.js` and `content.css` to inject a Shadow DOM overlay only when a `<video>` element is present. The new UI will rely on absolute positioning for drag-and-drop, completely isolating its CSS from hostile host environments. Crucially, all API requests to the Python daemon will be proxied through `background.js` to bypass page-level Content Security Policy (CSP) blocks.

## User Review Required
No user review is required at this stage. The architecture strictly follows the provided `floating_ui_architecture.md` skill guidelines.

## Open Questions
None. The architecture and requirements are well-defined in the spec.

## Proposed Changes

### Extension Files

#### [MODIFY] [manifest.json](file:///home/abdallah/Desktop/thunder/extension/manifest.json)
- Modify the `content_scripts` block for `content.js`:
  - Ensure `all_frames: true`.
  - Add `run_at: "document_end"` or `"document_idle"` to ensure the DOM is somewhat parsed before injection attempts.
- Ensure `content.css` is registered under `web_accessible_resources`.

#### [MODIFY] [background.js](file:///home/abdallah/Desktop/thunder/extension/background.js)
- Add a message listener to handle proxying requests from the content script to the Python daemon.
- Implement handlers for:
  - `GET_TAB_STREAMS`: Responds with the cached format data for the tab/URL.
  - `TRIGGER_DOWNLOAD`: Executes the `POST /api/download` request to the daemon.

#### [REWRITE] [content.js](file:///home/abdallah/Desktop/thunder/extension/content.js)
- **Top-Level Enforcement Removal**: Remove `if (window !== window.top) return;`.
- **Lazy Injection Logic**: Implement a `MutationObserver` to watch for `<video>` tags. Only initialize the Shadow DOM when a video is found.
- **Shadow DOM Setup**: Create `div#thunder-host`, attach a closed shadow root, and inject `<link rel="stylesheet" href="${chrome.runtime.getURL('content.css')}">`.
- **Drag Logic**: Implement `mousedown`, `mousemove`, and `mouseup` using `style.left` and `style.top`. Use `Math.hypot(dx, dy) < 5` to distinguish drag vs. click. Bind `mousemove/mouseup` to `document` during a drag.
- **Data Flow**: Replace direct `fetch()` calls with `chrome.runtime.sendMessage` to `background.js`.

#### [REWRITE] [content.css](file:///home/abdallah/Desktop/thunder/extension/content.css)
- Implement premium dark-theme styles.
- Ensure no CSS variables are used for positional coordinates (`left`, `top`).
- Apply styles scoped strictly to elements within the Shadow DOM.

## Verification Plan

### Automated Tests
- N/A (Testing is manual in the browser).

### Manual Verification
1. **Embedded Videos**: Visit a site with an embedded YouTube iframe. Verify the button appears.
2. **Dragging**: Drag the button around the screen. Ensure it moves smoothly and doesn't trigger the dropdown.
3. **Clicking**: Click the button. Ensure the dropdown opens.
4. **CSP Evasion**: Visit a site with strict CSP (e.g., GitHub or Twitter). Try downloading a video. Ensure the download is dispatched successfully without CSP errors in the console.
