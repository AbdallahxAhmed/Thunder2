---
description: "Task list for Hybrid Floating UI implementation"
---

# Tasks: Hybrid Floating UI

**Input**: Design documents from `/specs/004-hybrid-floating-ui/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths are provided.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and basic structure

*(No general setup needed since project already exists, but we define the context)*

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before UI components can consume it.

- [x] T001 [P] Implement `GET_HYBRID_STREAMS` contract in `extension/background.js` to merge `tabBuffers` and `formatCache`.
- [x] T002 [P] Update `extension/content.css` to replicate the CSS variables, layout classes, and badges from `popup.css`.

**Checkpoint**: Foundation ready - UI implementation can now begin.

---

## Phase 3: User Story 1 - Unified Media Download Menu (Priority: P1) 🎯 MVP

**Goal**: The floating download button displays both raw intercepted streams (like M3U8) and parsed formats (like 1080p, 720p) in a single menu.

**Independent Test**: Visit a DRM-enabled site, open the floating UI menu, and verify both RAW streams and parsed resolutions appear correctly, matching the popup UI visually. Verify clicking a button successfully downloads without inline-handler errors.

### Implementation for User Story 1

- [x] T003 [US1] Update `extension/content.js` to dispatch `GET_HYBRID_STREAMS` instead of `GET_TAB_STREAMS` when opening the dropdown.
- [x] T004 [US1] Update `extension/content.js`'s `renderFormats` function to properly map `HybridStreamPayload` properties (badge, label, raw items) matching `popup.html` structure.
- [x] T005 [US1] Implement event delegation on `uiContainer` inside `extension/content.js` for `.download-btn` clicks to handle downloads safely without CSP violations.
- [x] T006 [US1] Update `TRIGGER_DOWNLOAD` dispatch inside the `extension/content.js` event delegate to explicitly include `url: window.location.href`.

**Checkpoint**: At this point, the unified menu should render flawlessly and successfully trigger downloads.

---

## Phase 4: User Story 2 - Robust Draggable Floating UI (Priority: P2)

**Goal**: Drag the floating download button anywhere without accidentally clicking it, and without breaking the host site's layout.

**Independent Test**: Drag the UI widget around the screen > 5px without the dropdown opening. Click the widget without moving it to ensure the dropdown opens. Verify CSS isolation holds on conflicting sites.

### Implementation for User Story 2

- [x] T007 [P] [US2] Update `extension/content.js` drag handlers (`onMouseMove`, `onMouseUp`) to strictly use pure JS `style.left` and `style.top` and avoid CSS classes for positioning.
- [x] T008 [P] [US2] Ensure `Math.hypot(dx, dy) > 5` logic is enforced in `extension/content.js` to distinguish drag vs click reliably.

**Checkpoint**: The widget is perfectly isolated and draggable without accidental clicks.

---

## Phase N: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T009 Code cleanup and removing any leftover `GET_TAB_STREAMS` legacy handlers.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: MUST complete before user stories to ensure data and styling are available.
- **User Stories (Phase 3+)**: Depend on Foundational phase.
- **Polish (Final Phase)**: Depends on all stories being complete.

### User Story Dependencies

- **User Story 1 (P1)**: Depends on T001 (Background proxy) and T002 (CSS Parity).
- **User Story 2 (P2)**: Can be implemented parallel to US1 as it touches different functions within `content.js`.

### Parallel Opportunities

- T001 and T002 can run in parallel.
- T007 and T008 can be tackled alongside T003-T006 since they touch distinct functions in `content.js`.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2: Foundational (CRITICAL)
2. Complete Phase 3: User Story 1
3. **STOP and VALIDATE**: Verify floating UI parity and background hybrid data flow.

### Incremental Delivery

1. Complete Foundational (Background script + CSS).
2. Complete US1 (Menu UI + Event Delegation). Test.
3. Complete US2 (Drag stability). Test.
