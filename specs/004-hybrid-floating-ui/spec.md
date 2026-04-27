# Feature Specification: hybrid-floating-ui

**Feature Branch**: `005-hybrid-floating-ui`  
**Created**: 2026-04-27  
**Status**: Draft  
**Input**: User description: "Analyze the provided `background.js`, `content.js`, `content.css`, `popup.js`, and `popup.css`. We need to rebuild `content.js` and `content.css` to implement the Hybrid Data Pipeline and UI Parity. The goal is to merge the UI parity of the popup with the floating nature of the content script, maintaining the background proxy pattern intact. Save the specification in `specs/004-hybrid-floating-ui/spec.md`. Wait for my approval before proceeding."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unified Media Download Menu (Priority: P1)

As a user browsing media sites, I want the floating download button to display both raw intercepted streams (like M3U8) and parsed formats (like 1080p, 720p) in a single consistent menu so I can choose the best option without opening the extension popup.

**Why this priority**: Combining intercepted streams with parsed formats into one unified menu is the core value proposition of the Hybrid Data Pipeline.

**Independent Test**: Can be tested by visiting a site with DRM/M3U8 streams and verifying both the "Master Stream (Adaptive)" and specific resolutions appear in the floating UI.

**Acceptance Scenarios**:

1. **Given** a page with both an M3U8 stream and yt-dlp formats, **When** I click the floating button, **Then** the dropdown shows the RAW master stream alongside the 1080p/720p formats.
2. **Given** I open the floating UI menu, **Then** it looks exactly like the popup interface, including CSS variables, rounded buttons, and resolution badges.

---

### User Story 2 - Robust Draggable Floating UI (Priority: P2)

As a user, I want to drag the floating download button anywhere on the page without accidentally clicking it, and without it breaking the host site's layout.

**Why this priority**: A floating UI that blocks content or is easily misclicked degrades the user experience.

**Independent Test**: Can be fully tested by dragging the button across the viewport and ensuring it doesn't trigger a click event, and inspecting the DOM to verify positioning uses absolute JS coordinates instead of CSS variables.

**Acceptance Scenarios**:

1. **Given** the floating UI is injected, **When** I drag it 100 pixels, **Then** it moves smoothly without opening the dropdown menu.
2. **Given** I click the floating button without dragging (movement < 5px), **When** I release the mouse, **Then** the dropdown menu opens.

### Edge Cases

- What happens when a site has strict CSP blocking inline styles? (Shadow DOM should handle `content.css` injection).
- How does system handle cases where no M3U8 is intercepted but yt-dlp finds formats? (Should render only yt-dlp formats gracefully).
- How does system handle dragging the button off-screen? (Should clamp to viewport bounds).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: `content.js` MUST NOT communicate directly with the local Python daemon. It MUST request data from `background.js` via the action `GET_HYBRID_STREAMS`.
- **FR-002**: `background.js` MUST handle `GET_HYBRID_STREAMS` by returning a unified payload combining the intercepted M3U8 stream (from `tabBuffers`) and parsed formats (from `formatCache`).
- **FR-003**: The Floating UI injected by `content.js` MUST replicate the DOM structure, CSS variables, flexbox layouts, and quality badges from `popup.html` and `popup.css`.
- **FR-004**: Intercepted M3U8 streams MUST be rendered in the UI specifically as "🎬 Master Stream (Adaptive)" and feature a "RAW" badge.
- **FR-005**: Parsed `yt-dlp` formats MUST be rendered with explicit resolutions (e.g., 1080p, 720p) and appropriate icons.
- **FR-006**: The Floating UI MUST reside completely within a `mode: 'closed'` Shadow Root.
- **FR-007**: Dragging logic MUST be implemented using pure JS (`style.left` and `style.top`), strictly forbidding CSS variables for positioning to prevent host page overrides.
- **FR-008**: Drag interactions MUST use `Math.hypot` to distinguish between intentional dragging and click-to-open events.

### Key Entities

- **Hybrid Stream Payload**: A JSON object containing an array of available download formats, merging intercepted raw streams (labeled RAW) and parsed yt-dlp formats.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% visual parity between the Floating UI formats list and the Popup UI, utilizing the exact same CSS variables and structural styling.
- **SC-002**: 0 instances of CORS errors or direct daemon communication from `content.js` (all traffic proxied via `background.js`).
- **SC-003**: False-positive clicks during drag operations are reduced to 0 by enforcing the `Math.hypot` > 5px drag threshold.
- **SC-004**: Zero CSS bleed or layout disruption on host websites due to strict Shadow DOM isolation and pure JS positioning.

## Assumptions

- We assume `background.js`'s existing interception logic (`tabBuffers`) correctly captures the M3U8 URLs.
- We assume the existing Daemon API format structure will not change.
