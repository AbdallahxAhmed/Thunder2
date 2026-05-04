# Implementation Plan: Hybrid Floating UI

**Branch**: `005-hybrid-floating-ui` | **Date**: 2026-04-27 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/004-hybrid-floating-ui/spec.md`

**Note**: This template is filled in by the `/speckit-plan` command. See `.specify/templates/plan-template.md` for the execution workflow.

## Summary

This plan outlines the architecture for the "Hybrid Floating UI" of the Thunder browser extension. It implements the Hybrid Data Pipeline by migrating the stream-fetching logic entirely to the background script and enforcing 100% UI parity between the `popup.html`/`popup.css` design and the injected `content.js`/`content.css` floating interface.

## Technical Context

**Language/Version**: JavaScript (ES2022+) / Manifest V3
**Primary Dependencies**: Chrome Extension APIs (`chrome.runtime`, `chrome.tabs`, `chrome.storage`)
**Storage**: N/A
**Testing**: N/A
**Target Platform**: Google Chrome / Chromium Browsers
**Project Type**: Browser Extension
**Performance Goals**: Zero-latency rendering using cached format data
**Constraints**: 
- Event Delegation MUST be used for Shadow DOM download buttons to bypass CSP constraints.
- `TRIGGER_DOWNLOAD` payload MUST use explicit `window.location.href` to prevent `undefined` URLs.
**Scale/Scope**: Impacts all media pages via `content.js`

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **[x] VIII. Hybrid Data Architecture**: The `GET_HYBRID_STREAMS` contract enforces that `content.js` strictly receives data from `background.js` acting as a proxy.
- **[x] IX. UI Parity & Design Consistency**: The floating UI design uses CSS variables mirroring the popup design, enforcing structural consistency.
- **[x] X. Shadow DOM & Interface Isolation**: Event delegation and pure JS positioning (checked via `Math.hypot`) are rigorously enforced.

## Project Structure

### Documentation (this feature)

```text
specs/004-hybrid-floating-ui/
├── plan.md              # This file
├── research.md          # Design decisions and alternatives
├── data-model.md        # Payload structures
├── contracts/           # Internal APIs
│   └── GET_HYBRID_STREAMS.md
└── tasks.md             # Pending execution
```

### Source Code (repository root)

```text
extension/
├── background.js       # To be updated with GET_HYBRID_STREAMS and merging logic
├── content.js          # To be updated with Event Delegation, Math.hypot, and new DOM structure
├── content.css         # To be updated to replicate popup.css UI parity variables
├── popup.js            # Reference (no major changes needed)
└── popup.css           # Reference (no major changes needed)
```

**Structure Decision**: Using the existing Chrome Extension directory (`extension/`). The changes are confined to `content.js`, `content.css`, and `background.js`.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

*(No violations. All constraints align precisely with the established Thunder Constitution).*
