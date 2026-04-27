# Implementation Plan: Shadow DOM Floating Download UI (v5)

**Branch**: `003-mv3-browser-interceptor` | **Date**: 2026-04-27 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification v5 from `specs/002-mv3-browser-interceptor/spec.md` (User Story 5, FR-026 through FR-035)

## Summary

The v6 update completely rewrites the content script (`content.js`) and its stylesheet (`content.css`) to use 'The Ghost Overlay Tracking System'. This completely abandons the manual drag-and-drop mechanics in favor of a robust system that automatically anchors the UI to the active `<video>` element on the page using `getBoundingClientRect()`, `ResizeObserver`, and `scroll` events. The host container is injected strictly at the `document.documentElement` root to completely bypass stacking context traps, and uses a closed Shadow DOM for absolute CSS isolation. Iframes are strictly ignored (`window !== window.top`).

## Technical Context

**Language/Version**: JavaScript ES2020+ (content script), CSS3 (content styles)
**Primary Dependencies**: Chrome Extensions API (MV3) — `chrome.runtime.sendMessage`, `chrome.storage.local`, Shadow DOM APIs
**Storage**: `chrome.storage.local` to persist the dragged position of the button
**Testing**: Manual Chrome testing on hostile sites (Dailymotion, YouTube)
**Target Platform**: Chrome 102+ (extension)
**Project Type**: Content script + Shadow DOM injected UI overlay
**Performance Goals**: UI anchors instantly on `document_idle`; low overhead tracking using native observers (`ResizeObserver`, `IntersectionObserver`).
**Constraints**: Must completely isolate CSS via Shadow DOM; must ignore iframes to prevent spam; must completely remove Euclidean math (`Math.hypot`); must inject strictly at the `document.documentElement` root.
**Scale/Scope**: Single browser instance, runs on top-level frames only.

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

### 3. `extension/content.js` (REWRITE)

**What it is**: The core content script that implements the Ghost Overlay Tracking System.

**Architecture** (following `ghost-overlay-tracker` skill rules):

#### 3a. Top-Level Enforcement
- Check `if (window !== window.top) return;` immediately on load.
- Prevents multiple buttons from rendering inside ads and embedded iframes.

#### 3b. Root-Level Shadow DOM Initialization
- Create `<div id="uhdd-host"></div>`.
- Apply `position: fixed !important; top: 0; left: 0; width: 100vw; height: 100vh; z-index: 2147483647 !important; pointer-events: none;` to the host.
- Attach shadow root: `const shadow = host.attachShadow({ mode: 'closed' });`.
- Inject `content.css` into the shadow root via `<link>`.
- Append host strictly to `document.documentElement`.

#### 3c. Ghost Overlay Tracking System
- Completely remove all legacy drag-and-drop logic (`mousedown`, `mousemove`, `mouseup`) and Euclidean math (`Math.hypot`).
- Create `trackVideo(videoElement)` function:
  - Uses `getBoundingClientRect()` on the video to calculate precise coordinates.
  - Applies coordinates to the button via CSS `transform` or `top`/`left`.
  - Sets up a `ResizeObserver` on the video to automatically call `updatePosition()`.
  - Sets up an `IntersectionObserver` on the video to hide the button when the video is out of view.
  - Attaches a window `scroll` event listener with `capture: true` to constantly sync the overlay position during fast scrolling.

#### 3d. Format Fetching & Mini-Dropdown
- On Click: Send `{type: "getFormats"}` via `chrome.runtime.sendMessage`.
- Render a dropdown inside the shadow root with quality options.
- Add click-outside listener (bound to the top document but checking composed paths) to close the dropdown.

#### 3e. Download Dispatch
- `POST` to `http://localhost:8000/api/download` with `{url: window.location.href, engine: "ytdlp", format_id}`
- On success → show temporary success indicator.

**Estimated lines**: ~220 lines

---

### 4. `extension/content.css` (REWRITE)

**What it is**: Premium CSS for the floating button and mini-dropdown, injected directly into the Shadow DOM.

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

**Key styles** (No longer need `.uhdd-` prefixes since we are in a Shadow DOM!):

- **`.floating-btn`** — `position: absolute;` (relative to the viewport-sized host). Small circular button (48×48px) with download arrow icon. `opacity: 0.8` → `1.0` on hover. Subtle `box-shadow`. `cursor: grab;`. `pointer-events: auto;`.
- **`.dropdown`** — Dark card (`var(--bg-main)`) with `border-radius: 12px`, `backdrop-filter: blur(8px)`, `max-height: 300px; overflow-y: auto`. Glassmorphism effect.
- **`.dropdown-item`** — Format row with hover highlight.
- **`.badge-*`** — Resolution badges (4K gold, QHD purple, HD blue, SD gray).
- **`.success-indicator`** — Green checkmark with fade-out animation.

**CSS Isolation**: Handled entirely by the Shadow DOM. No class prefixes needed.

**Estimated lines**: ~150 lines

---

## Change Summary

| File | Action | Lines Added/Changed | Complexity |
|------|--------|---------------------|------------|
| `extension/manifest.json` | Modify | +8 lines | Trivial — add one content_scripts block |
| `extension/background.js` | Modify | ~5 lines | Low — fallback for content script callers |
| `extension/content.js` | Rewrite | ~250 lines | High — Shadow DOM injection, drag-and-drop math, message passing |
| `extension/content.css` | Rewrite | ~150 lines | Medium — premium dark theme, glassmorphism, animations |

**Total estimated effort**: ~413 lines of code across 4 files.

**Zero daemon changes** — the entire feature is browser-side.

## Complexity Tracking

> No constitution violations. No complexity tracking needed.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Host page hijacks pointer events or stacking contexts | Button unresponsive or hidden | Host element uses `z-index: 2147483647 !important` and is injected at the `document.documentElement` root to avoid `body` traps. |
| Iframe spam | Duplicate buttons | strict `if (window !== window.top) return;` at the top of `content.js` |
| Fast scrolling desyncs overlay | Overlay detaches from video | Use `window.addEventListener('scroll', updatePos, true)` (capturing phase) to perfectly sync the overlay. |
| Content script cannot load `content.css` | Unstyled UI | Inject CSS using `chrome.runtime.getURL` and a `<link>` tag inside the Shadow DOM. |
| Cross-origin click outside | Dropdown doesn't close | Event listener on top document checks `event.composedPath()` to see if the click originated inside the shadow root. |
