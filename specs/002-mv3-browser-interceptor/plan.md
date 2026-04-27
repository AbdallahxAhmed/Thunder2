# Implementation Plan: IDM-Style Floating Download Button (v4)

**Branch**: `003-mv3-browser-interceptor` | **Date**: 2026-04-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification v4 from `specs/002-mv3-browser-interceptor/spec.md` (User Story 5, FR-025 through FR-035)

## Summary

The IDM-Style Floating Download Button adds a content script (`content.js`) and companion stylesheet (`content.css`) that detect `<video>` elements on any page via MutationObserver, inject a floating download button over the video player, and render an inline dark-mode quality picker dropdown. The button communicates with the existing `background.js` service worker (which already pre-fetches format data) to retrieve quality options, and dispatches download requests to the daemon. The manifest is updated to register the new content script pair.

## Technical Context

**Language/Version**: JavaScript ES2020+ (content script), CSS3 (content styles)
**Primary Dependencies**: Chrome Extensions API (MV3) — `chrome.runtime.sendMessage`, `MutationObserver`, DOM APIs
**Storage**: None (stateless content script; format cache lives in background.js)
**Testing**: Manual Chrome testing (extension)
**Target Platform**: Chrome 102+ (extension)
**Project Type**: Content script + injected UI overlay
**Performance Goals**: Button appears within 1 second of `<video>` DOM insertion; dropdown renders within 500ms of click (using pre-cached data from background.js)
**Constraints**: Must not interfere with page playback; must survive fullscreen transitions; must be idempotent across DOM mutations; CSS must not leak into host page
**Scale/Scope**: Single browser instance, runs on all pages

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Headless-First | ✅ PASS | No daemon GUI — floating button is browser-side content script UI only |
| II. Smart Routing | ✅ PASS | Uses existing `getFormats` message → background.js; dispatches with explicit `engine: "ytdlp"` |
| III. DRM Pipeline Isolation | ✅ PASS | Floating button uses yt-dlp format picker only — completely separate from DRM pipeline |
| IV. API-Driven Architecture | ✅ PASS | Download dispatch uses existing `POST /api/download` endpoint; no daemon changes needed |
| V. Observability | ✅ PASS | Content script logs injection events to browser console |
| VI. Test-First | ✅ PASS | Manual testing via quickstart guide; no daemon code changes needed |
| VII. Simplicity & YAGNI | ✅ PASS | 2 new files (`content.js`, `content.css`) + 1 manifest modification. Zero daemon changes. |

**Post-Design Re-Check**: All gates still pass. This feature is entirely browser-side — the daemon is untouched.

## Project Structure

### Documentation (this feature)

```text
specs/002-mv3-browser-interceptor/
├── plan.md              # This file (updated for v4)
├── research.md          # Phase 0: technical decisions (existing)
├── data-model.md        # Phase 1: entity definitions (existing)
├── quickstart.md        # Phase 1: testing guide (existing)
├── contracts/           # Existing contracts — no new contracts needed
└── tasks.md             # Phase 2: implementation tasks (next)
```

### Source Code (repository root)

```text
extension/
├── manifest.json          # MODIFY: add content_scripts block for content.js + content.css
├── background.js          # MODIFY: extend getFormats handler to support content script callers
├── content.js             # CREATE: MutationObserver, floating button, mini-dropdown, download dispatch
├── content.css            # CREATE: scoped dark-theme styles for floating button + dropdown
├── popup.html             # NO CHANGE
├── popup.css              # NO CHANGE
├── popup.js               # NO CHANGE
└── content_scripts/
    ├── eme_hook.js        # NO CHANGE
    └── bridge.js          # NO CHANGE

src/                       # NO CHANGES — daemon is untouched for this feature
```

**Structure Decision**: 2 new files (`content.js`, `content.css`) in `extension/` root. 2 existing files modified (`manifest.json`, `background.js`). Zero daemon changes.

## File Modification Details

### 1. `extension/manifest.json`

**What changes**: Add a third `content_scripts` entry for `content.js` and `content.css`.

**Current state** (2 content_scripts entries):
```json
"content_scripts": [
  { "matches": ["*://*/*"], "js": ["content_scripts/eme_hook.js"], "world": "MAIN", ... },
  { "matches": ["*://*/*"], "js": ["content_scripts/bridge.js"], ... }
]
```

**After** (3 entries — append new block):
```json
{
  "matches": ["*://*/*"],
  "js": ["content.js"],
  "css": ["content.css"],
  "run_at": "document_idle",
  "all_frames": true
}
```

**Why**: Registers the floating button content script and its stylesheet. Runs at `document_idle` (after DOM is ready) in the `ISOLATED` world (default) to avoid polluting the page's JS context. `all_frames: true` ensures video elements inside iframes are also covered.

**Estimated lines added**: 8 lines

---

### 2. `extension/background.js`

**What changes**: Modify the existing `getFormats` message handler to also support content script callers (which send `sender.tab` but don't pass `tabId` in the message body).

**Current behavior**: The `getFormats` handler expects `message.tabId` and `message.url` (set by `popup.js`).

**Required change**: When a content script sends `{type: "getFormats"}`, it arrives with `sender.tab` populated but `message.tabId` may be absent. The handler should:
1. Fall back to `sender.tab.id` if `message.tabId` is not provided
2. Fall back to `sender.tab.url` if `message.url` is not provided

**Before**:
```javascript
if (message.type === "getFormats") {
  const { tabId, url } = message;
  // ...
}
```

**After**:
```javascript
if (message.type === "getFormats") {
  const tabId = message.tabId ?? sender.tab?.id;
  const url = message.url ?? sender.tab?.url;
  if (!tabId || !url) {
    sendResponse({ ok: false, error: "Missing tab context" });
    return true;
  }
  // ... rest unchanged
}
```

**Why**: The popup manually passes `tabId` and `url` because it doesn't have a `sender.tab`. Content scripts *do* have `sender.tab`, so we use it as a fallback. This makes the handler work for both callers without breaking the existing popup flow.

**Estimated lines changed**: ~5 lines

---

### 3. `extension/content.js` (NEW)

**What it is**: The core content script that detects `<video>` elements and injects the floating download UI.

**Architecture** (following `floating_button_dom.md` skill rules):

#### 3a. MutationObserver Setup
- Observe `document.body` for `childList` and `subtree` mutations
- On each mutation batch, scan for new `<video>` elements
- Also run an initial scan on script load (for videos already in the DOM)

#### 3b. Video Detection & Button Injection (`processVideo(video)`)
- Find the video's direct parent container (injection target)
- Check for `data-uhdd-injected="true"` — skip if already injected (idempotency)
- Ensure the container has `position: relative` (set it if not)
- Create the floating button element (download icon)
- Mark container with `data-uhdd-injected="true"`
- Attach click handler to the button

#### 3c. Format Fetching (Button Click Handler)
- Send `{type: "getFormats"}` via `chrome.runtime.sendMessage`
- On success → call `renderDropdown(data, container)`
- On error → show error state in dropdown

#### 3d. Mini-Dropdown Rendering (`renderDropdown(data, container)`)
- Create dropdown container with quality options (video formats only, sorted by resolution)
- Each option shows: resolution badge, codec, filesize
- Clicking an option → `dispatchDownload(url, format_id)`
- Add click-outside listener to close the dropdown

#### 3e. Download Dispatch (`dispatchDownload(url, format_id)`)
- `POST` to `http://localhost:8000/api/download` with `{url, engine: "ytdlp", format_id}`
- On success → show temporary success indicator (green checkmark, auto-fade after 2s)
- On failure → show error state

#### 3f. SPA Handling
- Listen for URL changes via a cached `window.location.href` comparison
- On URL change, reset dropdown state but keep the button (the video element is reused)

**Estimated lines**: ~200 lines

---

### 4. `extension/content.css` (NEW)

**What it is**: Premium scoped CSS for the floating button and mini-dropdown.

**Design System** (matching established dark theme from `popup.css` and `floating_button_dom.md`):
```css
:root {
  --uhdd-bg-main: #0F172A;
  --uhdd-bg-card: #1E293B;
  --uhdd-text-primary: #F8FAFC;
  --uhdd-text-secondary: #94A3B8;
  --uhdd-accent: #6366F1;
  --uhdd-accent-hover: #4F46E5;
  --uhdd-success: #10B981;
  --uhdd-error: #EF4444;
  --uhdd-radius: 8px;
  --uhdd-z-index: 2147483640;
}
```

**Key scoped styles** (all prefixed with `.uhdd-*` to avoid CSS collisions with host pages):

- **`.uhdd-floating-btn`** — `position: absolute; top: 10px; right: 10px; z-index: var(--uhdd-z-index)`. Small circular button (36×36px) with download arrow icon. `opacity: 0.7` → `1.0` on hover. Subtle `box-shadow` glow on hover. `transition: all 0.2s ease-in-out`.
- **`.uhdd-dropdown`** — `position: absolute; top: 50px; right: 10px; z-index: var(--uhdd-z-index)`. Dark card (`--uhdd-bg-main`) with `border-radius: 12px`, `backdrop-filter: blur(8px)`, `max-height: 300px; overflow-y: auto`. Glassmorphism effect with semi-transparent background.
- **`.uhdd-dropdown-item`** — Format row with hover highlight (`--uhdd-bg-card`). Shows resolution, codec badge, and filesize. `cursor: pointer`.
- **`.uhdd-badge-*`** — Resolution badges (4K gold, QHD purple, HD blue, SD gray) matching `popup.css` badge styling.
- **`.uhdd-success-indicator`** — Green checkmark with fade-out animation (`@keyframes uhdd-fade-out`).
- **`.uhdd-error`** — Red error text state.
- **Scrollbar** — Dark-themed, minimal width, matching popup.css.

**CSS Isolation**: All classes prefixed with `uhdd-` to prevent any collision with host page styles.

**Estimated lines**: ~180 lines

---

## Change Summary

| File | Action | Lines Added/Changed | Complexity |
|------|--------|---------------------|------------|
| `extension/manifest.json` | Modify | +8 lines | Trivial — add one content_scripts block |
| `extension/background.js` | Modify | ~5 lines | Low — fallback for content script callers |
| `extension/content.js` | Create | ~200 lines | Medium — MutationObserver, DOM injection, message passing, download dispatch |
| `extension/content.css` | Create | ~180 lines | Medium — premium dark theme, glassmorphism, animations, CSS isolation |

**Total estimated effort**: ~393 lines of code across 4 files (2 new + 2 modified).

**Zero daemon changes** — the entire feature is browser-side. The existing `background.js` format cache and `POST /api/download` endpoint are reused as-is.

## Complexity Tracking

> No constitution violations. No complexity tracking needed.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| CSS leaks into host page | Visual corruption of websites | All classes prefixed with `uhdd-`; CSS custom properties namespaced with `--uhdd-` |
| Host page CSS overrides floating button | Button invisible or mispositioned | Use `!important` on critical positioning rules; `z-index: 2147483640` |
| MutationObserver performance on heavy DOM pages | Page slowdown | Observer callback uses `requestAnimationFrame` batching; only processes `<video>` elements |
| Video parent container lacks `position: relative` | Button positioned wrong | Content script explicitly sets `position: relative` on the container if not already set |
| YouTube's custom player structure | Button injected in wrong container | Target `.html5-video-player` parent specifically on YouTube; generic parent fallback for other sites |
| SPA navigation doesn't trigger new content script | Stale format data shown | URL change detection via cached `location.href` comparison on MutationObserver callbacks |
| Dropdown overlaps with native video controls | Poor UX | Button at `top: 10px, right: 10px`; dropdown opens downward, away from bottom controls |
