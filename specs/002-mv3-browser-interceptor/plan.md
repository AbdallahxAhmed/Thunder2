# Implementation Plan: UHDD Browser Interceptor (MV3 Extension)

**Branch**: `003-mv3-browser-interceptor` | **Date**: 2026-04-26 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `specs/002-mv3-browser-interceptor/spec.md`

## Summary

Build a Chrome Manifest V3 extension that silently intercepts DRM video manifests
(`.mpd` / `.m3u8`) and Widevine decryption keys (`KID:KEY`) from browsing sessions,
then dispatches them to the local UHDD daemon via `POST /api/download`. The extension
uses a MAIN-world content script for EME hooking, a bridge script for message passing,
and a service worker for daemon communication and user notifications.

## Technical Context

**Language/Version**: JavaScript (ES2022) — Chrome extension (no build step)
**Primary Dependencies**: Chrome Extension APIs (MV3), Chrome Notifications API
**Storage**: In-memory per-tab interception buffer (no persistent storage)
**Testing**: Manual testing with sample Widevine DASH players; automated unit testing not applicable for MAIN-world EME hooks
**Target Platform**: Chrome 102+ / Chromium-based browsers with Manifest V3 support
**Project Type**: Browser extension (Chrome MV3)
**Performance Goals**: Payload dispatch within 5 seconds of video playback start
**Constraints**: No build tooling, plain JS only, no popup UI, zero interference with page playback
**Scale/Scope**: Single-user local extension; communicates only with `localhost:8000`

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Evidence |
|-----------|--------|----------|
| I. Headless-First | ✅ | No popup UI. Extension operates silently in background. |
| II. Smart Routing | ✅ | Extension feeds data into existing daemon router — no routing changes needed. |
| III. DRM Pipeline Isolation | ✅ | Extension captures KID:KEY from the browser's own EME pipeline. Never cracks or brute-forces DRM. |
| IV. API-Driven Architecture | ✅ | All daemon communication uses `POST /api/download` JSON endpoint. |
| V. Observability | N/A | Browser extension — `console.log` for development diagnostics only. |
| VI. Test-First | ⚠️ | MAIN-world EME hooks cannot be unit-tested with pytest. Manual E2E testing documented. See Complexity Tracking. |
| VII. Simplicity | ✅ | 4 plain JS files, zero build step, zero external dependencies. |

## Project Structure

### Documentation (this feature)

```text
specs/002-mv3-browser-interceptor/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (message schemas)
└── tasks.md             # Phase 2 output (/speckit-tasks)
```

### Source Code (repository root)

```text
extension/
├── manifest.json                  # MV3 manifest: permissions, content scripts, service worker
├── background.js                  # Service worker: daemon fetch, notifications, tab state
└── content_scripts/
    ├── eme_hook.js                # MAIN world: EME + fetch/XHR interception
    └── bridge.js                  # Isolated world: event relay to service worker
```

**Structure Decision**: Flat `extension/` directory at project root. Content scripts
grouped in `content_scripts/` sub-directory per user specification. No sub-packages,
no build step — files are loaded directly by Chrome.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| VI. Test-First: no automated unit tests | MAIN-world EME hooks execute inside Chrome's content script sandbox; they cannot be imported into pytest or Node.js test runners | Manual E2E test procedures documented in quickstart.md. Extension logic is simple enough that manual verification is sufficient for v1. |
