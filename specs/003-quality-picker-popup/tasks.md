# Tasks: Quality Picker Popup

**Input**: Design documents from `/specs/003-quality-picker-popup/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/, research.md

## Phase 1: Setup
*(No specific setup tasks required as this is an additive feature)*

## Phase 2: Foundational (Models & Engines)

- [x] T001 [P] Modify `extension/manifest.json` to add action block with popup
- [x] T002 [P] Modify `src/models.py` to add `format_id` to DownloadRequest and new InfoResponse models
- [x] T003 [P] Modify `src/engines/ytdlp_client.py` to add `extract_info` method and `format_id` support

## Phase 3: User Story 1 & 2 - Format Discovery & Unsupported Pages

- [x] T004 [US1] Modify `src/main.py` to add `GET /api/info` endpoint (depends on T002, T003)
- [x] T005 [P] [US1] Create `extension/popup.html` with structure for 4 states
- [x] T006 [P] [US1] Create `extension/popup.css` matching the premium dark theme
- [x] T007 [US1] Create `extension/popup.js` with format fetching and dispatch logic (depends on T004, T005)

## Phase 4: Polish

- [x] T008 Test popup interactions and ensure UI states match specs
