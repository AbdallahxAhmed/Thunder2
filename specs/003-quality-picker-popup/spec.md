# Feature Specification: Quality Picker Popup (yt-dlp Integration)

**Feature Branch**: `004-quality-picker-popup`
**Created**: 2026-04-27
**Status**: Deprecated / Removed
**Input**: User description: "The Quality Picker Popup — a premium dark-themed browser extension popup that queries available media formats via yt-dlp and allows users to select a specific quality before dispatching the download."

> **DEPRECATION NOTICE**: The extension popup UI was officially removed in v3.14.4. The architecture has fully migrated to a Headless Extension + Hybrid Floating Pill UI (injected via closed Shadow DOM) for a more seamless, zero-context-switching user experience. This spec remains for historical reference.

## User Scenarios & Testing

### User Story 1 - Format Discovery & Quality Selection (Priority: P1)

A user navigates to a supported media site (YouTube, Twitter/X, Vimeo, etc.) and clicks the extension icon. The popup opens, automatically detects the active tab's URL, and queries the UHDD daemon for available download formats. The popup displays a clean, grouped list of video formats (with resolution and codec info) and audio-only formats. The user clicks their preferred format, and the download is dispatched to the daemon using yt-dlp with that specific format.

**Why this priority**: This is the core value proposition — giving users control over download quality instead of always defaulting to "best". Without this, the extension offers no interactive download selection.

**Independent Test**: Install the extension, navigate to a YouTube video, click the extension icon, verify formats are listed, click a format, and verify the daemon receives a download request with the correct format identifier.

**Acceptance Scenarios**:

1. **Given** the extension is installed, the daemon is running, and the user is on a YouTube video page, **When** the user clicks the extension icon, **Then** the popup opens and displays a loading state while querying formats.
2. **Given** the popup is loading, **When** the daemon responds with available formats, **Then** the popup displays video formats grouped separately from audio-only formats, each showing resolution, codec, and file size (when available).
3. **Given** the format list is displayed, **When** the user clicks a video format button, **Then** the extension dispatches a download request to the daemon with `engine: "ytdlp"` and the selected `format_id`, and the popup transitions to a success state.
4. **Given** the user clicks a format, **When** the daemon accepts the download, **Then** a success message is displayed with a green checkmark and the download ID.

---

### User Story 2 - Unsupported Page Handling (Priority: P2)

A user clicks the extension icon while on a page that is not a recognized media site (e.g., a news article, a settings page, or `chrome://` internal pages). The popup displays a friendly message indicating no downloadable media was detected, rather than showing an error or broken state.

**Why this priority**: Graceful handling of non-media pages prevents user confusion and maintains trust in the extension's reliability.

**Independent Test**: Navigate to a non-media page (e.g., google.com), click the extension icon, verify the popup shows a friendly "no media" message without errors.

**Acceptance Scenarios**:

1. **Given** the user is on a non-media page, **When** the user clicks the extension icon, **Then** the popup displays "No downloadable media detected on this page." with a neutral, friendly tone.
2. **Given** the user is on a `chrome://` or `chrome-extension://` page, **When** the user clicks the extension icon, **Then** the popup displays the same "no media" message without attempting to query the daemon.

---

### User Story 3 - Daemon Offline Resilience (Priority: P2)

A user clicks the extension icon on a media page, but the UHDD daemon is not running. The popup shows an appropriate error state indicating the backend is unreachable, rather than hanging indefinitely or crashing.

**Why this priority**: The daemon may not always be running. Users need clear feedback about connectivity issues so they can take corrective action.

**Independent Test**: Stop the daemon, navigate to a YouTube video, click the extension icon, verify the popup shows a "backend offline" error message.

**Acceptance Scenarios**:

1. **Given** the daemon is not running, **When** the user opens the popup on a media page, **Then** the popup transitions from loading to an error state displaying "Backend offline — start the UHDD daemon."
2. **Given** the daemon becomes unreachable mid-interaction (e.g., during format dispatch), **When** the download request fails, **Then** the popup displays an error message without crashing.

---

### User Story 4 - Premium Dark Theme Visual Experience (Priority: P3)

The popup presents a visually premium dark-themed interface with smooth animations and modern aesthetics that reflects the quality of the UHDD project. The UI uses a carefully curated color palette, modern typography, and subtle micro-animations.

**Why this priority**: Visual polish enhances user trust and engagement. A professional UI differentiates the extension from basic download tools.

**Independent Test**: Open the popup and visually verify the dark theme, color palette, hover transitions, loading animations, and typography match the design specification.

**Acceptance Scenarios**:

1. **Given** the popup opens, **Then** it renders with a deep slate background, indigo accent colors, and off-white text on all elements.
2. **Given** a list of format buttons is displayed, **When** the user hovers over a button, **Then** a smooth transition effect is visible within 200ms.
3. **Given** the popup is in the loading state, **Then** a CSS-animated spinner or pulse effect is displayed with the text "Sniffing formats…".

---

### Edge Cases

- What happens when yt-dlp returns zero formats for a valid media URL? → The popup displays "No formats available for this media." with a suggestion to check the URL.
- What happens when the format list is very long (50+ formats)? → The popup scrolls gracefully with a styled scrollbar; the popup height is capped at a reasonable maximum.
- What happens when the user clicks the popup icon multiple times rapidly? → Only one format query is active at a time; duplicate requests are suppressed.
- What happens if the tab URL changes while the popup is open? → The popup was initialized with the URL at open time; it does not re-query on tab change.
- What happens if yt-dlp extraction takes a long time (>10 seconds)? → The loading state continues; a timeout of 30 seconds is applied, after which the popup shows a timeout error.
- What happens when format_id is provided to the download endpoint? → The daemon passes it directly to yt-dlp as the `-f` argument, overriding the default "bestvideo+bestaudio/best".
- What happens if format_id is invalid? → yt-dlp itself will report the error, which propagates as a failed download job in the daemon.

## Requirements

### Functional Requirements

- **FR-001**: The daemon MUST expose a format discovery endpoint that accepts a media URL and returns available download formats without initiating a download.
- **FR-002**: The format discovery response MUST include for each format: format identifier, resolution (for video), codec name, file size estimate (when available), and a human-readable label.
- **FR-003**: The format discovery endpoint MUST separate video formats from audio-only formats in the response.
- **FR-004**: The `DownloadRequest` model MUST accept an optional `format_id` field that specifies which format to download.
- **FR-005**: When `format_id` is provided, the daemon MUST pass it to yt-dlp as the format selection argument, overriding the default quality selection.
- **FR-006**: The daemon MUST ensure the output is muxed into MP4 format when a format-specific download is requested.
- **FR-007**: The extension manifest MUST declare a popup action with a default popup HTML page.
- **FR-008**: The popup MUST automatically detect the active tab's URL when opened.
- **FR-009**: The popup MUST validate the active tab's URL against a list of known media site domains before querying the daemon.
- **FR-010**: The popup MUST display a loading state with visual feedback while querying formats.
- **FR-011**: The popup MUST display format results grouped into video formats and audio-only formats.
- **FR-012**: The popup MUST allow the user to click a format to dispatch a download request with `engine: "ytdlp"` and the selected `format_id`.
- **FR-013**: The popup MUST display a success confirmation after a download is successfully dispatched.
- **FR-014**: The popup MUST display a "no media" message when the active page is not a recognized media site.
- **FR-015**: The popup MUST display a "backend offline" error when the daemon is unreachable.
- **FR-016**: The popup MUST use a premium dark theme with the specified color palette (Slate black, Indigo accent).
- **FR-017**: All interactive elements in the popup MUST have smooth hover transitions.
- **FR-018**: The popup MUST cap its height and support scrolling for long format lists.

### Key Entities

- **Format**: A single downloadable format returned by yt-dlp, containing an identifier, resolution, codec, file size estimate, and type (video or audio-only).
- **Format List**: A grouped collection of formats separated into video and audio-only categories.
- **Popup State**: One of four states the popup can be in: loading, loaded (format list), success (download dispatched), or error (no media / backend offline).
- **Format Query**: A request from the popup to the daemon to retrieve available formats for a given URL.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users can view available formats and dispatch a download within 3 clicks (icon click → format click → confirmed).
- **SC-002**: Format discovery completes and displays results within 10 seconds for 90% of supported media URLs.
- **SC-003**: The popup correctly identifies and handles non-media pages with zero false dispatches.
- **SC-004**: The popup renders with the premium dark theme on every open — no flashes of unstyled content.
- **SC-005**: All popup state transitions (loading → loaded, loaded → success, loading → error) are visually smooth.
- **SC-006**: Downloads dispatched with a specific `format_id` produce output in the requested quality and format.

## Assumptions

- The UHDD daemon is running locally on `http://localhost:8000`.
- The user has Chrome 102+ with Manifest V3 support.
- yt-dlp is installed and available as a Python module in the daemon environment.
- The popup is a browser action popup (not a new tab or sidebar).
- The list of known media site domains reuses the existing `KNOWN_MEDIA_DOMAINS` set from `router.py` (exposed via a new endpoint or hardcoded in the extension).
- The format discovery endpoint does not cache results — each popup open triggers a fresh query.
- The popup does not persist state between opens — each open starts fresh.
- The popup width is fixed at a standard browser extension popup width (~360px); height is dynamic but capped.
