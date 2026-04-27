# Feature Specification: UHDD Floating UI (The Draggable Ghost)

**Feature Branch**: `004-floating-ui-rewrite`
**Created**: 2026-04-27
**Status**: Active

## 1. Overview
The UHDD extension requires a complete rewrite of its in-page floating download button (`content.js` and `content.css`). The previous iteration suffered from CSS conflicts with hostile host sites, event hijacking during interactions, and Content Security Policy (CSP) blocks when trying to communicate with the local Python daemon. 

This rewrite implements the "Dumb UI / Smart Interceptor" architecture to create a flawless, highly resilient "Draggable Ghost" overlay.

## 2. Architecture Pillars

### 2.1 UI Encapsulation (Shadow DOM)
- A host element (`<div id="uhdd-host">`) must be created and a closed Shadow Root attached (`mode: 'closed'`).
- ALL UI elements and CSS must live strictly inside this shadow boundary to prevent host CSS leakage and Z-index wars.
- CSS must be injected into the Shadow Root via a `<link rel="stylesheet" href="chrome-extension://.../content.css">` tag, with `content.css` exposed in `web_accessible_resources`.

### 2.2 Smart Lazy Injection (No Iframe Spam)
- The script must NOT use the legacy top-frame enforcement (`if (window !== window.top) return;`), as this breaks functionality on sites using embedded players (e.g., embedded YouTube iframes).
- Instead, the script will execute in all frames but will ONLY inject the Shadow DOM host if a physical `<video>` element is detected in that specific frame using a `MutationObserver`.

### 2.3 Interaction & Positioning (The Draggable Ghost)
- Drag logic must utilize pure JS absolute positioning (`style.left`, `style.top`) based on pointer offsets.
- CSS variables (e.g., `--btn-x`, `--btn-y`) are strictly forbidden for positioning to avoid conflicts with pseudo-classes like `:active`.
- The system must cleanly distinguish between a drag and a click using Euclidean distance (`Math.hypot(dx, dy) < 5` constitutes a click).
- To prevent event hijacking when the cursor moves quickly, `mousemove` and `mouseup` events must be bound to the `document` during a drag operation.

### 2.4 Data Flow (Dumb UI / Smart Interceptor)
- The Floating Button acts strictly as a "Dumb UI".
- `content.js` MUST NOT execute direct `fetch()` calls to the local Python daemon. Doing so triggers strict CSP errors on sites like X/Twitter and GitHub.
- **Fetching Data**: The content script requests formats by sending a message to `background.js` (e.g., `{ type: "getFormats" }`).
- **Triggering Downloads**: The content script requests a download by sending a message to `background.js` (e.g., `{ type: "triggerDownload", payload: {...} }`). The Service Worker (`background.js`) is responsible for executing the `POST` request to the daemon.

## 3. User Scenarios

### Scenario 1: Video Detection in Embedded Iframes
- **Given** a user loads a page with an embedded iframe containing a `<video>`,
- **When** the `MutationObserver` within that specific frame detects the video element,
- **Then** the UI injects the Shadow DOM and floating button into that frame, allowing the user to download the embedded video.

### Scenario 2: Dragging the Overlay
- **Given** the floating button is visible,
- **When** the user clicks and drags the button across the screen,
- **Then** the button follows the cursor smoothly via absolute positioning updates, and drops cleanly when the mouse is released. The `Math.hypot` check ensures the dropdown does not accidentally open.

### Scenario 3: Opening the Dropdown
- **Given** the floating button is visible,
- **When** the user explicitly clicks the button without dragging (`Math.hypot` distance < 5),
- **Then** the button sends a message to `background.js` to fetch cached formats, and a quality selection dropdown is rendered within the Shadow DOM.

### Scenario 4: Triggering a Download (Bypassing CSP)
- **Given** the user has opened the quality dropdown,
- **When** the user clicks a specific resolution (e.g., 1080p),
- **Then** `content.js` sends a message to `background.js`, which then securely executes the `fetch()` POST request to the local Python daemon, bypassing any page-level CSP restrictions.

## 4. Functional Requirements
- **FR-001**: `content.js` MUST execute in all frames (`all_frames: true` in `manifest.json`).
- **FR-002**: `content.js` MUST NOT inject the UI unless a `<video>` element is present in the DOM (detected initially or via `MutationObserver`).
- **FR-003**: The UI MUST be rendered inside a closed Shadow DOM attached to a host element.
- **FR-004**: Styles MUST be loaded into the Shadow DOM via a `<link>` tag pointing to `content.css`.
- **FR-005**: Dragging MUST be implemented using absolute `left` and `top` style properties.
- **FR-006**: Drag logic MUST use `Math.hypot(dx, dy) < 5` to differentiate a click from a drag.
- **FR-007**: Drag events (`mousemove`, `mouseup`) MUST be bound to the `document` to prevent event loss.
- **FR-008**: ALL network requests (fetching formats, triggering downloads) MUST be delegated to `background.js` via `chrome.runtime.sendMessage`.

## 5. Key Entities
- **Shadow Host**: The root element `div#uhdd-host` containing the Shadow DOM.
- **Draggable Ghost**: The main floating button element, positioned via absolute coordinates.
- **Smart Interceptor (`background.js`)**: The service worker responsible for actual communication with the daemon, bypassing page-level CSP.

## 6. Success Criteria
- **SC-001**: The floating button correctly appears on video pages, even within embedded iframes.
- **SC-002**: The button can be dragged smoothly without getting stuck or unintentionally opening the dropdown.
- **SC-003**: Clicking the button opens the format dropdown (data fetched securely via `background.js`).
- **SC-004**: Selecting a format successfully queues a download via the Python daemon (dispatch handled by `background.js`), bypassing all CSP restrictions.
