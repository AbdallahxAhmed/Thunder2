---
description: "Task list for IDM-Style Floating Pill implementation"
---

# Tasks: IDM-Style Floating Pill (The Morphing Download Pill)

**Input**: Design documents from `/specs/005-idm-floating-pill/`
**Prerequisites**: spec.md (required), existing `background.js` hybrid pipeline (spec 004 — completed)

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Exact file paths provided.

---

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before any pill UI can render.

- [ ] T001 [P] Rewrite `extension/content.css` — strip all legacy FAB/dropdown styles. Implement new design system: `:host` reset, pill variants (full/mini), menu panel, quality buttons (ported from popup.css), hover transitions, morph animation keyframes, and size-adaptive breakpoint classes.
- [ ] T002 [P] Scaffold `extension/content.js` — replace legacy globals with new architecture: `Map<HTMLVideoElement, PillInstance>` registry, `STATE_PILL`/`STATE_MENU` constants, `PillInstance` factory function, and the single `#thunder-host` + closed Shadow DOM injection per frame.
- [ ] T003 Implement video detection system in `extension/content.js` — `MutationObserver` on `document.body` that detects `<video>` elements added/removed. On add: check dimensions via `getBoundingClientRect()`, reject if width < 150 or height < 150, otherwise call `createPill(video)`. On remove: call `destroyPill(video)`.

**Checkpoint**: Shadow DOM host injects. Video elements detected. Pill instances created/destroyed. No visual output yet.

---

## Phase 2: User Story 1 — Video-Anchored Download Pill (Priority: P1) 🎯 MVP

**Goal**: Pills appear on hover, track video position, and adapt to video size.

**Independent Test**: Navigate to YouTube. Hover over the video. See the pill at top-right. Scroll and verify it follows. Mouse away and verify it fades.

### Implementation for User Story 1

- [ ] T004 [US1] Implement `createPill(video)` in `extension/content.js` — creates pill DOM element inside Shadow DOM, determines size class (full/mini) from video width, positions it at video's top-right via `getBoundingClientRect()`, and registers the `PillInstance` in the Map.
- [ ] T005 [US1] Implement position tracking in `extension/content.js` — attach `ResizeObserver` to each tracked video (re-classify size + re-position pill), add `scroll` + `resize` event listeners that batch position updates via `requestAnimationFrame`. All coordinate recalculations must go through a single `updatePillPosition(pillInstance)` function.
- [ ] T006 [US1] Implement `IntersectionObserver` in `extension/content.js` — observe each tracked video. When video leaves viewport, force pill to `opacity: 0; pointer-events: none` (suppress hover). When video enters viewport, restore hover-responsive behavior.
- [ ] T007 [US1] Implement hover visibility in `extension/content.js` — detect hover on `<video>` elements (mouseenter/mouseleave on video and pill). On hover: set pill `opacity: 1; pointer-events: auto`. On leave: start 300ms grace timer, then fade to `opacity: 0` if mouse hasn't re-entered video or pill. Skip fade-out if pill is in `STATE_MENU`.
- [ ] T008 [US1] Implement `destroyPill(video)` in `extension/content.js` — disconnect all observers (`ResizeObserver`, `IntersectionObserver`), remove event listeners, remove pill DOM node from Shadow DOM, delete entry from Map.

**Checkpoint**: Pills appear on hover, track video, adapt to size, fade out. No click behavior yet.

---

## Phase 3: User Story 2 — Morphing Pill-to-Menu Expansion (Priority: P1) 🎯 MVP

**Goal**: Clicking the pill morphs it into a format menu. Selecting a format or clicking outside collapses it back.

**Independent Test**: Click the pill on a YouTube video. Verify morphing animation. Verify format list matches popup. Click a format. Verify it dispatches download and collapses.

### Implementation for User Story 2

- [ ] T009 [US2] Implement click handler and state machine in `extension/content.js` — on `mouseup` (when `Math.hypot < 5` and state is `STATE_PILL`): transition to `STATE_MENU`. Calculate `transform-origin` from pill position relative to video center. Expand pill element via CSS class toggle that triggers `transform: scale()` transition.
- [ ] T010 [US2] Implement `renderFormats(data, pillInstance)` in `extension/content.js` — populate the expanded menu with format buttons. Replicate popup.js's rendering: quality icons, label text, badges (HD/4K/QHD/RAW/AUDIO), format details row, download arrow. Use event delegation on the pill container for `.format-btn` clicks.
- [ ] T011 [US2] Implement format button click handler in `extension/content.js` — on `.format-btn` click: extract `data-format-id`, dispatch `{ action: "TRIGGER_DOWNLOAD", payload: { url: window.location.href, format_id, engine: "ytdlp" } }` via `chrome.runtime.sendMessage`. Show success indicator. Transition to `STATE_PILL`.
- [ ] T012 [US2] Implement menu close triggers in `extension/content.js` — (a) click outside: listen on `document` for `mousedown`, check `composedPath()` excludes pill, transition to `STATE_PILL`. (b) Escape key: `keydown` listener. (c) Format selected (handled in T011).
- [ ] T013 [US2] Implement `GET_HYBRID_STREAMS` dispatch in `extension/content.js` — when transitioning to `STATE_MENU`, show loading state inside the expanding menu, send `{ action: "GET_HYBRID_STREAMS", url: window.location.href }` to `background.js`, call `renderFormats()` on response.

**Checkpoint**: Full pill → menu → download → collapse flow works. Visually matches popup.

---

## Phase 4: User Story 3 — Draggable Pill (Priority: P2)

**Goal**: Pill can be dragged within video bounds. Drag offset survives scroll/resize.

**Independent Test**: Drag the pill from top-right to bottom-left of the video. Scroll page. Verify pill maintains offset. Click (without drag) and verify menu opens.

### Implementation for User Story 3

- [ ] T014 [US3] Implement drag system in `extension/content.js` — on `mousedown` (STATE_PILL only): record start coordinates. Bind `mousemove`/`mouseup` on `document`. In `mousemove`: if `Math.hypot > 5`, enter drag mode, update pill position clamped to video rect. In `mouseup`: if was dragging, store offset in `pillInstance.dragOffset`; if not dragging, trigger click (state transition to `STATE_MENU`).
- [ ] T015 [US3] Update `updatePillPosition()` in `extension/content.js` — when recalculating position (scroll/resize), apply stored `dragOffset` relative to video's top-left corner. Re-clamp offset if video has resized and offset would place pill outside new bounds.

**Checkpoint**: Pill is draggable within video, offset persists through scroll/resize, no conflict with click.

---

## Phase 5: User Story 4 — Size-Adaptive Multi-Video (Priority: P2)

**Goal**: Multiple videos on one page each get their own correctly-sized pill.

**Independent Test**: Create test page with 3 videos (800px, 300px, 100px). Verify: full pill, mini pill, no pill respectively.

### Implementation for User Story 4

- [ ] T016 [US4] Implement size classification in `extension/content.js` — `classifyVideoSize(video)` returns `"full"` (width > 400), `"mini"` (150 < width ≤ 400), or `null` (skip). Called on initial detection and on `ResizeObserver` callback. When class changes, update pill DOM (add/remove text label, adjust width via CSS class).
- [ ] T017 [US4] Stress-test multi-video in `extension/content.js` — ensure `MutationObserver` correctly handles: rapid add/remove of videos, video elements moving between parent containers, videos initially hidden then revealed (IntersectionObserver picks them up).

**Checkpoint**: Multi-video pages work. Size adapts. No memory leaks.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Refinements that span all stories.

- [ ] T018 Update `extension/manifest.json` — verify `content.css` is in `web_accessible_resources` and all permissions are correct (cookies, downloads, notifications already present).
- [ ] T019 RAW stream handling — when `GET_HYBRID_STREAMS` returns a RAW intercept option, ensure the pill shows it as "🎬 Master Stream" with RAW badge, and `TRIGGER_DOWNLOAD` correctly sends `format_id: "raw-intercept"` to background.js for buffer lookup.
- [ ] T020 Update `AGENTS.md` to point to `specs/005-idm-floating-pill/spec.md` as the current plan.
- [ ] T021 Code cleanup — remove any remaining legacy content.js/content.css patterns. Verify no dead references.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No prerequisites beyond completed spec 004 pipeline. BLOCKS all user stories.
- **US1 (Phase 2)**: Depends on Phase 1.
- **US2 (Phase 3)**: Depends on Phase 2 (needs visible pills to click).
- **US3 (Phase 4)**: Depends on Phase 2 (needs positioned pills to drag). Can run parallel with US2.
- **US4 (Phase 5)**: Depends on Phase 2 (extends existing pill creation). Can run parallel with US2/US3.
- **Polish (Phase 6)**: Depends on all stories.

### Parallel Opportunities

- T001 and T002 can run in parallel (CSS vs JS scaffolding).
- T014–T015 (drag) can run parallel with T009–T013 (morph) since they touch distinct code paths within content.js.
- T016–T017 (multi-video) can run parallel with T009–T013 (morph).

---

## Implementation Strategy

### MVP First (User Story 1 + 2)

1. Complete Phase 1: Foundational (CSS + JS scaffold + video detection)
2. Complete Phase 2: US1 (pills appear, track, hover)
3. Complete Phase 3: US2 (morphing, format selection, download)
4. **STOP AND VALIDATE**: Full download flow works from hover → click → select → download.
5. Then add US3 (drag) and US4 (multi-video sizing) incrementally.

### File Impact Summary

| File | Change Type | Scope |
|---|---|---|
| `extension/content.js` | **Full rewrite** | Replace draggable ghost with multi-pill IDM system |
| `extension/content.css` | **Full rewrite** | Replace FAB styles with pill/menu/morph design system |
| `extension/manifest.json` | Minor edit | Verify permissions and web_accessible_resources |
| `extension/background.js` | **No changes** | Hybrid pipeline already complete |
| `extension/popup.*` | **No changes** | Independent UI surface |
| `AGENTS.md` | Minor edit | Update spec pointer |

---

## Notes

- [P] tasks = different files, no dependencies.
- [Story] label maps task to specific user story.
- Constitution Principles VIII (Hybrid Data), IX (UI Parity), X (Shadow DOM Isolation) all apply.
- `content.js` is a full rewrite — no incremental patching of the legacy FAB code.
- Commit after each task or logical group.
- Stop at any checkpoint to validate independently.
