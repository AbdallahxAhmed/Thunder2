# Feature Specification: IDM-Style Floating Pill (The Morphing Download Pill)

**Feature Branch**: `005-hybrid-floating-ui`  
**Created**: 2026-05-03  
**Status**: Draft  
**Supersedes**: Spec 002 v6 "Ghost Overlay Tracking System" (never implemented), Spec 003 "Floating UI Rewrite" (Draggable Ghost — now legacy)  
**Depends On**: Spec 004 "Hybrid Floating UI" (completed — `GET_HYBRID_STREAMS` pipeline intact)  
**Input**: Grill session 2026-05-03 — IDM-style video-anchored download pill with morphing expand/collapse UI, multi-video support, and iframe-aware injection.

## Design Context

### Why the Draggable Ghost is Being Replaced

The previous Draggable Ghost (circular FAB) had three fundamental UX problems:

1. **No visual association with the video.** A floating circle in the corner of the viewport doesn't communicate "I download THIS video." On pages with multiple embedded players, it's ambiguous.
2. **Manual positioning burden.** Users must drag the button away from subtitles, controls, or overlapping elements every time a page loads.
3. **Foreign UI pattern.** A draggable circle is not a recognized download affordance. IDM's rectangular bar anchored to the video is universally understood.

### The IDM Model

Internet Download Manager injects a compact rectangular download bar directly onto each `<video>` element. The bar appears on hover, is visually integrated with the video player, and provides instant access to download options. This spec replicates and extends that model with a morphing pill/menu interaction.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 — Video-Anchored Download Pill (Priority: P1)

A user navigates to a website with a video player. When the user hovers over the video, a compact rectangular pill ("⬇ Download") smoothly fades into view, anchored to the top-right corner of the video element. The pill visually tracks the video — if the user scrolls, resizes the window, or the video enters fullscreen, the pill follows perfectly. If the user moves the mouse away from both the video and the pill, it fades out.

**Why this priority**: Without the pill appearing and tracking the video, nothing else works. This is the visual foundation of the entire feature.

**Independent Test**: Navigate to any site with a `<video>` element (e.g., YouTube, Dailymotion, a raw HTML5 video). Hover over the video. Verify the pill appears anchored to the top-right. Scroll the page and verify it tracks. Mouse away and verify it fades.

**Acceptance Scenarios**:

1. **Given** the extension is installed, **When** a page loads with a `<video>` element whose dimensions are ≥ 150px in both width and height, **Then** a pill element is created inside the Shadow DOM and positioned at the video's top-right corner using `getBoundingClientRect()`.
2. **Given** the pill is created, **When** the user is NOT hovering over the video or the pill, **Then** the pill has `opacity: 0` and `pointer-events: none`.
3. **Given** the user hovers over the `<video>` element, **When** the mouseenter event fires, **Then** the pill transitions to `opacity: 1` with a smooth CSS transition (200ms ease).
4. **Given** the pill is visible, **When** the user scrolls the page or resizes the window, **Then** the pill's position updates to match the video's new `getBoundingClientRect()` coordinates, synced via `requestAnimationFrame`.
5. **Given** a page with multiple `<video>` elements, **When** the user hovers over Video #2, **Then** only Video #2's pill becomes visible — Video #1's pill remains hidden.

---

### User Story 2 — Morphing Pill-to-Menu Expansion (Priority: P1)

A user clicks the visible download pill. The pill smoothly expands in-place into a format selection menu showing available download qualities (from `GET_HYBRID_STREAMS`). The expansion direction is dynamically calculated based on the pill's position within the video rect — if the pill is near the bottom-right, the menu expands toward the top-left, and vice versa. The menu displays the same quality options, badges, and styling as the popup UI. Selecting a format or clicking outside the menu collapses it back into the pill.

**Why this priority**: The morphing interaction IS the core differentiator from a generic dropdown. Without it, the pill is just a button. This is co-P1 with US1 because a pill that doesn't open is useless.

**Independent Test**: Click the pill on a YouTube video. Verify it morphs into a menu with quality options. Verify the expansion direction adapts when the pill is repositioned. Click a format and verify it collapses back.

**Acceptance Scenarios**:

1. **Given** the pill is visible and in `STATE_PILL`, **When** the user clicks it (with `Math.hypot(dx, dy) < 5`), **Then** the pill transitions to `STATE_MENU`: it expands in-place to reveal the format list, animated via CSS `transform` + `transition`.
2. **Given** the pill is near the bottom-right of the video rect, **When** it expands, **Then** the `transform-origin` is set to `bottom right` so the menu grows toward the top-left.
3. **Given** the pill is near the top-left of the video rect, **When** it expands, **Then** the `transform-origin` is set to `top left` so the menu grows toward the bottom-right.
4. **Given** the menu is open (`STATE_MENU`), **When** the user clicks a format button, **Then** the download is dispatched via `TRIGGER_DOWNLOAD` to `background.js`, and the menu collapses back to `STATE_PILL`.
5. **Given** the menu is open (`STATE_MENU`), **When** the user clicks anywhere outside the menu, **Then** the menu collapses back to `STATE_PILL`.
6. **Given** the menu is open, **Then** the format list matches the popup UI: same CSS variables, quality badges (HD, 4K, QHD, RAW), icons, and layout structure.

---

### User Story 3 — Draggable Pill Within Video Bounds (Priority: P2)

A user wants to move the download pill because it's blocking subtitles. The user clicks and drags the pill to a different position within the video's bounding rectangle. The pill stays anchored relative to the video — when the page scrolls, the pill moves with the video while maintaining the user's drag offset. Dragging is only available in `STATE_PILL`; in `STATE_MENU`, mouse interactions are reserved for format selection and scrolling.

**Why this priority**: Subtitle obstruction is a real UX pain point, but users can still download without dragging. Core functionality works without this.

**Independent Test**: Drag the pill from the top-right corner to the bottom-left of the video. Scroll the page and verify the pill maintains its relative position within the video. Click the pill (without dragging) and verify the menu still opens.

**Acceptance Scenarios**:

1. **Given** the pill is in `STATE_PILL`, **When** the user clicks and moves the mouse more than 5px (`Math.hypot(dx, dy) > 5`), **Then** dragging begins and the pill follows the cursor.
2. **Given** dragging is active, **When** the user moves the cursor outside the video's bounding rect, **Then** the pill position is clamped to remain within the video boundaries.
3. **Given** dragging completes, **When** the user releases the mouse, **Then** the pill's offset from the video's top-left corner is stored (in-memory, not persisted to `chrome.storage`).
4. **Given** the pill is in `STATE_MENU`, **When** the user clicks and drags, **Then** nothing happens — dragging is completely disabled in menu state to prevent conflicts with format button clicks and list scrolling.
5. **Given** the video resizes (e.g., entering fullscreen), **When** the pill's stored offset would place it outside the new video rect, **Then** the offset is re-clamped to fit within the new boundaries.

---

### User Story 4 — Size-Adaptive Multi-Video Support (Priority: P2)

A user navigates to a page with multiple video elements of varying sizes (e.g., a portfolio page, a social media feed). The extension creates one pill per qualifying video, adapting the pill's visual presentation based on each video's dimensions. Large videos get a full text+icon pill, small videos get an icon-only mini pill, and tiny/hidden videos (ads, trackers, preloaders) are completely ignored.

**Why this priority**: Multi-video pages are common but not the primary use case (anime sites typically have one video per iframe). Works without this, but needed for completeness.

**Independent Test**: Create an HTML page with three `<video>` elements: one 800px wide, one 300px wide, and one 100px wide. Verify: large gets full pill, medium gets mini pill, small gets nothing.

**Acceptance Scenarios**:

1. **Given** a `<video>` element with width > 400px, **When** the pill is created, **Then** it renders as a full rectangular bar with icon + "Download" text.
2. **Given** a `<video>` element with 150px < width ≤ 400px, **When** the pill is created, **Then** it renders as a compact mini pill with icon only (no text).
3. **Given** a `<video>` element with width < 150px OR height < 150px, **When** the content script scans the DOM, **Then** no pill is created for that video (acts as ad/tracker filter).
4. **Given** a video is dynamically resized (e.g., entering/exiting fullscreen), **When** it crosses a size threshold, **Then** the pill transitions between full/mini variants smoothly.
5. **Given** a `<video>` element is removed from the DOM, **When** the `MutationObserver` detects the removal, **Then** the corresponding pill is destroyed and removed from the tracking Map with zero memory leaks.

---

### Edge Cases

- What if a `<video>` has no `src` and is only used for WebRTC/canvas rendering? → Pill still injects (video element exists). Download will likely fail gracefully via the daemon.
- What if a cross-origin iframe contains the only `<video>`? → content.js runs in that frame via `all_frames: true`. Pill injects inside the iframe's Shadow DOM overlay. `chrome.runtime.sendMessage` works across frame boundaries.
- What if the `<video>` element is recreated (YouTube ad break → main content)? → `MutationObserver` detects removal of old video, destroys its pill. Detects new video, creates new pill.
- What if the user has the menu open and the video resizes? → The menu stays open but re-calculates its transform-origin. If the resize makes the menu overflow, it re-clamps.
- What if two videos overlap? → Each video gets its own pill. Pills have `z-index: 2147483647` inside the Shadow DOM and are layered in DOM order.
- What if `getBoundingClientRect()` returns zero dimensions (video hidden via `display: none`)? → Treat as < 150px — no pill.
- What if the page uses `pointer-events: none` on the video? → The hover detection can fall back to `mousemove` coordinate checking against the video rect, since the Ghost Overlay host has `pointer-events: none` and the pill has `pointer-events: auto`.

---

## Requirements *(mandatory)*

### Functional Requirements

#### Pill Lifecycle & Tracking

- **FR-001**: `content.js` MUST maintain a `Map<HTMLVideoElement, PillInstance>` tracking all active video-pill associations in each frame.
- **FR-002**: `content.js` MUST use a `MutationObserver` on `document.body` (or `document.documentElement`) to detect `<video>` elements being added to or removed from the DOM.
- **FR-003**: When a `<video>` is added, `content.js` MUST check its dimensions via `getBoundingClientRect()`. If both width ≥ 150px and height ≥ 150px, a pill MUST be created and tracked.
- **FR-004**: When a tracked `<video>` is removed from the DOM, its pill MUST be destroyed and the entry removed from the Map.
- **FR-005**: `content.js` MUST use `IntersectionObserver` on each tracked `<video>` to hide the pill (and suppress hover) when the video is scrolled out of the viewport.
- **FR-006**: `content.js` MUST run in all frames (`all_frames: true` in manifest). There is NO `window === window.top` guard.

#### Positioning & Tracking

- **FR-007**: Pill position MUST be calculated using `getBoundingClientRect()` on the associated `<video>` element, anchoring to the top-right corner by default.
- **FR-008**: Position updates from scroll, resize, and DOM layout changes MUST be batched through `requestAnimationFrame` to prevent synchronous DOM thrashing.
- **FR-009**: A `ResizeObserver` MUST be attached to each tracked `<video>` to detect size changes (e.g., fullscreen transitions) and re-position + re-classify (full/mini/hidden) the pill.
- **FR-010**: The host element (`#thunder-host`) MUST use `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; pointer-events: none; z-index: 2147483647;` to escape host page stacking contexts.

#### Size-Adaptive UI

- **FR-011**: Videos with width > 400px MUST get a full pill (icon + "Download" text).
- **FR-012**: Videos with 150px < width ≤ 400px MUST get a mini pill (icon only).
- **FR-013**: Videos with width < 150px OR height < 150px MUST be ignored entirely.
- **FR-014**: When a video crosses a size threshold due to resize, the pill MUST transition between full/mini variants with a smooth CSS animation.

#### Hover-Activated Visibility

- **FR-015**: Pills MUST default to `opacity: 0; pointer-events: none;` (invisible and non-interactive).
- **FR-016**: When the user hovers over the associated `<video>` OR the pill itself, the pill MUST transition to `opacity: 1; pointer-events: auto;` with a 200ms CSS ease transition.
- **FR-017**: When the mouse leaves BOTH the `<video>` and the pill, and the pill is in `STATE_PILL`, it MUST fade back to `opacity: 0` after a 300ms grace period.
- **FR-018**: If the pill is in `STATE_MENU`, it MUST remain visible regardless of hover state until the menu is explicitly closed.

#### State Machine (Pill ↔ Menu)

- **FR-019**: The pill MUST have exactly two states: `STATE_PILL` (compact bar) and `STATE_MENU` (expanded format list).
- **FR-020**: Transition from `STATE_PILL` → `STATE_MENU` MUST occur on click (with `Math.hypot(dx, dy) < 5` to exclude drags).
- **FR-021**: Transition from `STATE_MENU` → `STATE_PILL` MUST occur on: (a) format selection, (b) click outside the menu, (c) Escape key press.
- **FR-022**: The expansion MUST use CSS `transform: scale()` + `transition` with dynamically computed `transform-origin` based on the pill's position relative to the video center.
- **FR-023**: In `STATE_MENU`, the format list MUST replicate the popup UI's DOM structure, CSS variables, quality badges, and styling per Constitution Principle IX (UI Parity).

#### Drag Logic

- **FR-024**: Dragging MUST only be active in `STATE_PILL`. In `STATE_MENU`, drag is completely disabled.
- **FR-025**: Drag MUST use `Math.hypot(dx, dy) > 5` threshold to distinguish from clicks, consistent with existing implementation.
- **FR-026**: During drag, the pill position MUST be clamped to remain within the associated `<video>` element's `getBoundingClientRect()`.
- **FR-027**: The drag offset (relative to the video's top-left corner) MUST be stored in-memory only (NOT persisted to `chrome.storage.local`).
- **FR-028**: Drag events (`mousemove`, `mouseup`) MUST be bound to `document` during active drag to prevent event loss when the cursor moves outside the pill.

#### Data Flow (Unchanged — Hybrid Pipeline)

- **FR-029**: `content.js` MUST NOT communicate directly with the Python daemon. All data requests go through `background.js` via `chrome.runtime.sendMessage`.
- **FR-030**: Format fetching MUST use `{ action: "GET_HYBRID_STREAMS" }` — unchanged from spec 004.
- **FR-031**: Download dispatch MUST use `{ action: "TRIGGER_DOWNLOAD", payload: { url, format_id, engine } }` — unchanged from spec 004.
- **FR-032**: The URL sent in both messages MUST be `window.location.href` (the frame's own URL). `background.js` overrides this with `sender.tab.url` for yt-dlp requests.

### Key Entities

- **Pill**: A compact rectangular download bar anchored to a specific `<video>` element. Has two visual variants: full (icon + text) and mini (icon only).
- **Menu**: The expanded format selection list that the pill morphs into. Contains quality option buttons with badges.
- **Pill Instance**: Internal object tracking a single video-pill pair: `{ video: HTMLVideoElement, pill: HTMLElement, state: STATE_PILL | STATE_MENU, dragOffset: {x, y}, sizeClass: "full" | "mini" }`.
- **Video Pill Map**: `Map<HTMLVideoElement, PillInstance>` — the central registry in each frame.
- **Transform Origin**: The CSS `transform-origin` value (e.g., `top left`, `bottom right`) calculated dynamically to ensure the menu expands away from the video edge.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Pills appear within 100ms of hovering over a qualifying `<video>` element on pages with up to 10 videos without janking the host page's paint cycle.
- **SC-002**: Zero CSS bleed or layout disruption on host pages due to strict Shadow DOM isolation and pure JS positioning.
- **SC-003**: The morphing animation (pill → menu) completes in ≤ 300ms and feels fluid on 60Hz displays.
- **SC-004**: Drag false-positives (accidental menu opens during drag) are zero, enforced by the `Math.hypot > 5` threshold.
- **SC-005**: 100% visual parity between the expanded menu format list and the popup UI's format list (same badges, colors, layout).
- **SC-006**: Zero memory leaks — destroying a video's pill releases all event listeners, observers, and DOM references.
- **SC-007**: The pill correctly anchors and tracks across: page scroll, window resize, video fullscreen toggle, and dynamic DOM relayout.

---

## Assumptions

- The existing `GET_HYBRID_STREAMS` and `TRIGGER_DOWNLOAD` message contracts in `background.js` are stable and will not change for this feature.
- The `eme_hook.js` + `bridge.js` DRM interception pipeline continues to run in `all_frames: true` and is unaffected by this UI rewrite.
- `content.css` will be fully rewritten. The existing popup.css is the styling reference.
- The popup UI (`popup.html`, `popup.js`, `popup.css`) is NOT modified by this feature. It continues to work independently.
- The Python daemon backend is NOT modified by this feature. The API contract is stable.
- `IntersectionObserver` and `ResizeObserver` are available in all target browsers (Chrome 102+).
- Cross-origin iframes allow content script injection via manifest `all_frames: true` — Chrome handles this natively for extension content scripts.
- The `cookies` permission has been added to the manifest (completed as a prerequisite fix).
