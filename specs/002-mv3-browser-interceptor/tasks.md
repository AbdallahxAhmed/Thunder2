# Tasks: IDM-Style Floating Download Button (v4)

**Input**: Design documents from `/specs/002-mv3-browser-interceptor/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US5)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

*(No specific setup tasks required as this is an additive feature to an existing project)*

---

## Phase 2: Foundational (Blocking Prerequisites)

*(No foundational tasks required as project infrastructure exists)*

---

## Phase 3: User Story 4 - Native Download Hijacking to aria2 (Priority: P2)

*(Previously completed in v3)*
- [x] T001 [P] [US4] Add "downloads" permission to `extension/manifest.json`
- [x] T002 [P] [US4] Add `referer` and `engine` fields + `engine` validator to `DownloadRequest` in `src/models.py`
- [x] T003 [P] [US4] Update `aria2_client.py` to support `referer` in `add_download` and `execute` in `src/engines/aria2_client.py`
- [x] T004 [US4] Modify `submit_download` in `src/main.py` to respect the explicit `engine` field override (depends on T002)
- [x] T005 [US4] Implement `chrome.downloads.onCreated` listener and anti-loop guard in `extension/background.js` (depends on T001)

---

## Phase 4: User Story 5 - IDM-Style Floating Download Button on Video Players (Priority: P2)

**Goal**: Inject a floating download button directly over the video player on any website, providing instant access to quality selection and downloading without leaving the page.

**Independent Test**: Navigate to YouTube, verify floating button appears over video, click to see dropdown, click a format to dispatch download to daemon.

### Implementation for User Story 5

- [x] T007 [P] [US5] Add `content_scripts` block for `content.js` and `content.css` to `extension/manifest.json`.
- [x] T008 [P] [US5] Update `getFormats` message handler in `extension/background.js` to fallback to `sender.tab.id` and `sender.tab.url`.
- [x] T009 [P] [US5] Create `extension/content.css` with scoped dark-theme styles for floating button and dropdown (`--uhdd-*` prefixed).
- [x] T010 [US5] Implement Ghost Overlay Tracking System with root-level injection, MutationObserver, and Anti-Jank scroll throttling in `extension/content.js`.

---

## Final Phase: Polish & Cross-Cutting Concerns

- [x] T011 Run manual validation of the floating button on a test video site.

---

## Dependencies & Execution Order

### Parallel Opportunities

- T007, T008, T009 can be executed in parallel as they modify different, independent files.
- T010 should be done after T009 to ensure styles are available, but is independent of T007/T008.
