# Tasks: Auto-DRM Pipeline

**Input**: Design documents from `specs/006-auto-drm-pipeline/`
**Prerequisites**: spec.md (required), constitution.md v1.2.0 (Principle III amendment)

**Tests**: Not explicitly requested — test tasks omitted.

**Organization**: Tasks grouped by user story. All three stories are co-P1 and form a sequential pipeline (US1 → US2 → US3), but can be tested independently at each checkpoint.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Environment configuration and verification

- [ ] T001 Add `WVD_PATH=device.wvd` to `.env` file
- [ ] T002 Verify `device.wvd` exists at project root and is loadable by pywidevine (manual check)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Verify existing backend DRM pipeline is wired correctly before touching the frontend

- [ ] T003 Verify `src/engines/widevine_cdm.py` — `WidevineCDM._ensure_cdm()` loads `device.wvd` from `settings.wvd_path` without errors
- [ ] T004 Verify `src/engines/m3u8_client.py` — `M3u8Client._resolve_keys()` correctly branches: (a) pre-extracted `drm_keys`, (b) CDM negotiation via `pssh` + `license_url`, (c) empty fallback
- [ ] T005 Verify `src/models.py` — `DownloadRequest` model accepts `pssh`, `license_url`, `license_headers`, `title`, `drm_hint` fields (already present)
- [ ] T006 Verify `background.js` — `TRIGGER_DOWNLOAD` handler for `raw-intercept` already enriches payload with `pssh`, `license_url`, `license_headers`, `drm_hint`, `title` from `tabBuffers` (lines 294-311)

**Checkpoint**: Backend pipeline confirmed functional. Frontend work can begin.

---

## Phase 3: User Story 1 — Smart Title Extraction (Priority: P1) 🎯 MVP

**Goal**: Every `TRIGGER_DOWNLOAD` payload includes a sanitized `document.title` as the `title` field.

**Independent Test**: Click any format button on any video page. Inspect the `TRIGGER_DOWNLOAD` message in the background console. Verify `title` is present and sanitized.

### Implementation for User Story 1

- [ ] T007 [US1] Add `sanitizePageTitle()` function to `extension/content.js` that: (a) grabs `document.title`, (b) strips common site suffixes (`" - YouTube"`, `" | Prime Video"`, `" - Dailymotion"`, `" - Watch Online"`, `" - Crunchyroll"`, `" - Netflix"`, `" - Watch Free"`, `" · GitHub"`), (c) removes illegal filesystem characters (`/\\:*?"<>|`), (d) collapses whitespace, (e) trims, (f) truncates to 200 chars, (g) returns `null` if empty
- [ ] T008 [US1] Modify the `setupGlobalInteractions()` click handler in `extension/content.js` to call `sanitizePageTitle()` and include `title: sanitizedTitle` in the `TRIGGER_DOWNLOAD` message payload (line ~596)
- [ ] T009 [US1] Verify `background.js` passes `title` through for non-RAW formats in the `TRIGGER_DOWNLOAD` fetch call to the daemon (title should be included in the JSON body alongside `url`, `format_id`, `engine`)

**Checkpoint**: Title flows from content.js → background.js → daemon for ALL format types.

---

## Phase 4: User Story 2 — EME Bridge / Payload Enrichment (Priority: P1)

**Goal**: RAW format button triggers carry DRM metadata (`pssh`, `license_url`, `license_headers`) from `tabBuffers` to the daemon.

**Independent Test**: Navigate to a DRM-protected page. Wait for `[Thunder SW] DRM package cached` in the background console. Click RAW. Verify the outgoing `POST /api/download` body contains `pssh`, `license_url`, `license_headers`.

### Implementation for User Story 2

- [ ] T010 [US2] Audit `background.js` `TRIGGER_DOWNLOAD` handler for `raw-intercept` path (lines 294-311) — confirm it attaches `buffer.pssh`, `buffer.licenseUrl` → `license_url`, `buffer.licenseHeaders` → `license_headers`, `buffer.drmHint` → `drm_hint`, `buffer.title` → `title` to the payload before the `fetch()` call
- [ ] T011 [US2] Fix if needed: ensure `background.js` also includes `title` from the content script's `TRIGGER_DOWNLOAD` message (not just `buffer.title`) — the content script's sanitized title (from T008) should take precedence over the buffer's raw title
- [ ] T012 [US2] Verify `background.js` correctly serializes `license_headers` as a JSON object in the fetch body (not stringified or dropped)
- [ ] T013 [US2] Verify the non-RAW path in `background.js` `TRIGGER_DOWNLOAD` handler passes through `title` from the message payload to the daemon request body

**Checkpoint**: RAW click on DRM page → daemon receives full payload with `url`, `title`, `pssh`, `license_url`, `license_headers`.

---

## Phase 5: User Story 3 — Auto-Widevine Backend Decryption (Priority: P1)

**Goal**: Backend receives enriched payload → negotiates keys via pywidevine → appends `--key` flags → `N_m3u8DL-RE` decrypts and muxes to `.mp4`.

**Independent Test**: `curl -X POST http://localhost:8000/api/download -H "Content-Type: application/json" -d '{"url":"<manifest_url>","pssh":"<base64>","license_url":"<url>","license_headers":{"Authorization":"Bearer xxx"},"title":"Test Video"}'` — verify backend logs show key extraction and N_m3u8DL-RE command with `--key` flags.

### Implementation for User Story 3

- [ ] T014 [US3] Verify `src/engines/m3u8_client.py` `_resolve_keys()` — when `request.pssh` and `request.license_url` are both set, it imports and calls `widevine_cdm.negotiate_keys()` with correct arguments including `license_headers`
- [ ] T015 [US3] Verify `src/engines/m3u8_client.py` `execute()` — the `--key` flags are correctly appended to the `cmd` list for each key pair returned by `_resolve_keys()`
- [ ] T016 [US3] Verify `src/engines/m3u8_client.py` `_generate_save_name()` — when `request.title` is provided, it sanitizes and uses it as the filename; when absent, falls back to URL hash
- [ ] T017 [US3] Verify `src/main.py` download routing — when `pssh` and `license_url` are present in the request, the engine is routed to `m3u8` (not aria2 or ytdlp)
- [ ] T018 [US3] Verify error handling — when `device.wvd` is missing or CDM negotiation fails, a structured error response is returned to the extension (not a 500 crash)

**Checkpoint**: Full end-to-end DRM pipeline functional. RAW click → decrypted `.mp4` with clean filename.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, logging, and cleanup

- [ ] T019 [P] Add structured log messages in `m3u8_client.py` for the CDM negotiation path: log the license URL, number of keys extracted, and the final N_m3u8DL-RE command (redact key values)
- [ ] T020 [P] Verify `eme_hook.js` `sanitizeTitle()` function (line 77-86) is consistent with the new `content.js` `sanitizePageTitle()` function — both should produce identical output for the same input
- [ ] T021 Update `extension/manifest.json` if any new permissions or content script entries are needed (likely none — audit only)
- [ ] T022 End-to-end manual test: navigate to a DRM-protected site → hover → click RAW → verify decrypted `.mp4` with clean filename appears in `downloads/`

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — immediate
- **Foundational (Phase 2)**: Depends on Phase 1 — verification only, no code changes expected
- **US1 (Phase 3)**: Depends on Phase 2 — modifies `content.js` only
- **US2 (Phase 4)**: Depends on Phase 3 (needs title in payload) — modifies/audits `background.js`
- **US3 (Phase 5)**: Depends on Phase 4 (needs enriched payload) — verifies/audits backend Python
- **Polish (Phase 6)**: Depends on all story phases

### User Story Dependencies

- **US1 → US2 → US3**: Sequential pipeline. Each story adds a layer:
  - US1: Title enters the payload
  - US2: DRM metadata enters the payload
  - US3: Backend processes the complete payload
- Stories CAN be tested independently at each checkpoint, but implementation order matters.

### Within Each User Story

- Audit/verify existing code before writing new code
- New code before integration verification
- Integration verification before checkpoint sign-off

### Parallel Opportunities

- T003, T004, T005, T006 (Phase 2 verification) can all run in parallel
- T019, T020 (Phase 6 polish) can run in parallel
- T007 can start while Phase 2 verification is in progress (different files)

---

## Implementation Strategy

### MVP First (All Stories — They're Co-P1)

1. Complete Phase 1: Setup (`.env` config)
2. Complete Phase 2: Foundational (verify backend is already wired)
3. Complete Phase 3: US1 (title in payload) → **TEST**
4. Complete Phase 4: US2 (DRM metadata enrichment) → **TEST**
5. Complete Phase 5: US3 (backend decryption) → **TEST END-TO-END**
6. Complete Phase 6: Polish

### Key Insight

Most backend code **already exists** (`widevine_cdm.py`, `m3u8_client.py`, `background.js` DRM enrichment). The primary new code is:
- `sanitizePageTitle()` in `content.js` (~20 lines)
- Adding `title` to the `TRIGGER_DOWNLOAD` payload in `content.js` (~2 lines)
- Possibly fixing `background.js` to pass `title` through for non-RAW paths (~3 lines)

The rest is **verification and integration testing** of existing code paths.

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Many tasks are "verify" not "implement" — the backend DRM pipeline is already coded
- The primary new code is in `content.js` (title extraction + payload enrichment)
- `background.js` may need minor fixes to pass `title` through for non-RAW paths
- Commit after each phase checkpoint
