# Tasks: UHDD Browser Interceptor (MV3 Extension)

**Input**: Design documents from `specs/002-mv3-browser-interceptor/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Not included — browser extension MAIN-world EME hooks cannot be unit-tested with standard frameworks. Manual E2E verification procedures are documented in quickstart.md. See plan.md Complexity Tracking for justification.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- Extension code lives in `extension/` at the repository root
- Content scripts in `extension/content_scripts/`
- Icons in `extension/icons/`

## Phase 1: Setup (Extension Scaffolding)

**Purpose**: Create the extension directory structure and manifest

- [ ] T001 Create extension directory structure: `extension/`, `extension/content_scripts/`, `extension/icons/`
- [ ] T002 Create `extension/manifest.json` with Manifest V3 configuration: `manifest_version: 3`, `name: "UHDD Browser Interceptor"`, `version: "1.0"`, `permissions: ["notifications"]`, `host_permissions: ["*://*/*", "http://localhost:8000/*"]`, `background.service_worker: "background.js"`, two `content_scripts` entries — one for `eme_hook.js` (`world: "MAIN"`, `run_at: "document_start"`, `all_frames: true`) and one for `bridge.js` (`run_at: "document_start"`, `all_frames: true`)
- [ ] T003 [P] Create placeholder extension icons in `extension/icons/`: `icon16.png`, `icon48.png`, `icon128.png` (simple colored squares or use a generate tool)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core messaging infrastructure that MUST be complete before user story implementation

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Implement the bridge content script in `extension/content_scripts/bridge.js`: listen for `window` custom event `uhdd_payload_ready`, extract `event.detail` (containing `type`, `url`, `drmKeys`), and forward to the service worker via `chrome.runtime.sendMessage({ type, url, drmKeys })`
- [ ] T005 Implement the service worker skeleton in `extension/background.js`: set up `chrome.runtime.onMessage.addListener` to receive messages from bridge.js, create a `Map` for per-tab interception buffers keyed by `sender.tab.id`, and add tab cleanup listeners (`chrome.tabs.onRemoved` to delete buffer entries, `chrome.tabs.onUpdated` with `changeInfo.status === 'loading'` to clear buffer on navigation)

**Checkpoint**: Extension loads without errors in `chrome://extensions/`, bridge can relay messages to service worker, tab buffers are created/cleaned up

---

## Phase 3: User Story 1 — Automatic DRM Stream Interception (Priority: P1) 🎯 MVP

**Goal**: Intercept `.mpd` manifest URLs and Widevine `KID:KEY` pairs from the page's EME pipeline, dispatch to UHDD daemon

**Independent Test**: Install extension, navigate to a Widevine DASH page, verify POST to `localhost:8000/api/download` with manifest URL and KID:KEY

### Implementation for User Story 1

- [ ] T006 [US1] Implement fetch/XHR interception in `extension/content_scripts/eme_hook.js`: override `window.fetch` to check if the request URL ends with `.mpd` and dispatch a `CustomEvent('uhdd_payload_ready', { detail: { type: 'manifest', url } })` before calling the original fetch; override `XMLHttpRequest.prototype.open` similarly for `.mpd` URLs
- [ ] T007 [US1] Implement EME hook in `extension/content_scripts/eme_hook.js`: override `navigator.requestMediaKeySystemAccess` to intercept `MediaKeySystemAccess`, then wrap `MediaKeys.prototype.createSession` to get the `MediaKeySession`, hook `MediaKeySession.prototype.generateRequest` to extract the `KID` from `initData` (parse PSSH box, extract 16-byte KID at known Widevine offset, convert to lowercase hex), and hook `MediaKeySession.prototype.update` to extract the `KEY` from the license response (parse Widevine license protobuf, extract content key bytes, convert to lowercase hex), then dispatch `CustomEvent('uhdd_payload_ready', { detail: { type: 'drm_keys', drmKeys: 'KID:KEY' } })`
- [ ] T008 [US1] Implement payload dispatch logic in `extension/background.js`: when a `manifest_captured` message arrives, store the URL in the tab's buffer; when a `drm_keys_captured` message arrives, store the keys in the tab's buffer; after each message, check if both `manifestUrl` and `drmKeys` are present — if so, call `dispatchToUHDD(tabId)` which sends `fetch('http://localhost:8000/api/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: buffer.manifestUrl, drm_keys: buffer.drmKeys }) })`
- [ ] T009 [US1] Implement deduplication in `extension/background.js`: maintain a `Set` of dispatched URLs per tab in the buffer; before dispatching, check if the manifest URL is already in the set; if so, skip dispatch; after successful dispatch, add the URL to the set

**Checkpoint**: Extension intercepts `.mpd` URLs and Widevine KID:KEY on a DRM page and sends the payload to localhost:8000

---

## Phase 4: User Story 2 — User Notification on Download Dispatch (Priority: P2)

**Goal**: Show Chrome notifications for successful dispatch ("Download Queued") and failures ("Backend Offline")

**Independent Test**: Trigger a dispatch with daemon running → "Download Queued" notification. Stop daemon, trigger dispatch → "Backend Offline" notification.

### Implementation for User Story 2

- [ ] T010 [US2] Add success notification in `extension/background.js`: after `fetch()` to the daemon returns a 2xx response, call `chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'UHDD: Download Queued', message: '<manifest_url> → <engine>' })` using the engine name from the response body
- [ ] T011 [US2] Add failure notification in `extension/background.js`: wrap the `fetch()` call in a try/catch; on network error or non-2xx response, call `chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: 'UHDD: Backend Offline', message: 'Could not reach UHDD daemon at localhost:8000' })`

**Checkpoint**: Users see native Chrome notifications for every dispatch attempt (success or failure)

---

## Phase 5: User Story 3 — Non-DRM Manifest Interception (Priority: P3)

**Goal**: Intercept `.m3u8` URLs and dispatch them to the daemon without DRM keys

**Independent Test**: Navigate to a page with an HLS stream, verify the extension dispatches the `.m3u8` URL with no `drm_keys` field.

### Implementation for User Story 3

- [ ] T012 [US3] Extend fetch/XHR interception in `extension/content_scripts/eme_hook.js`: add `.m3u8` URL detection alongside existing `.mpd` detection in both the `fetch` and `XMLHttpRequest.prototype.open` overrides
- [ ] T013 [US3] Add non-DRM dispatch path in `extension/background.js`: when a `manifest_captured` message arrives with a `.m3u8` URL and no DRM keys are buffered, dispatch immediately with `{ url: manifestUrl }` (no `drm_keys` field) after a short delay (e.g., 2 seconds) to allow DRM keys to arrive if applicable; skip the delay and dispatch immediately if the URL ends with `.m3u8` (since `.m3u8` without DRM keys is the expected case for HLS)

**Checkpoint**: Extension intercepts and dispatches `.m3u8` URLs alongside `.mpd` DRM streams

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Edge cases, cleanup, and validation

- [ ] T014 [P] Add IIFE wrapper to `extension/content_scripts/eme_hook.js`: wrap entire file in an Immediately Invoked Function Expression to avoid polluting the page's global scope with extension variables
- [ ] T015 [P] Add console logging with `[UHDD]` prefix to all extension files for debugging: log manifest captures, DRM key captures, dispatch attempts, and errors in `eme_hook.js`, `bridge.js`, and `background.js`
- [ ] T016 [P] Handle multiple `.mpd` manifests per page in `extension/background.js`: when a new manifest URL arrives for a tab that already has a different manifest URL buffered, dispatch the existing buffered payload first (if complete), then start a new buffer entry for the new URL
- [ ] T017 Perform manual E2E validation: load extension in Chrome, test against a Widevine DASH sample player, verify the full pipeline (intercept → bridge → service worker → daemon POST → notification) works end-to-end per quickstart.md procedures

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3+)**: All depend on Foundational phase completion
  - Stories should be implemented sequentially (P1 → P2 → P3) because each builds on the previous
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) — Core DRM pipeline, no dependencies on other stories
- **User Story 2 (P2)**: Depends on User Story 1 — Needs the dispatch logic from T008/T009 to add notifications to
- **User Story 3 (P3)**: Depends on User Story 1 — Extends the fetch/XHR interception and dispatch logic

### Within Each User Story

- EME hook / network interception before dispatch logic
- Dispatch logic before notifications
- Core implementation before edge cases
- Story complete before moving to next priority

### Parallel Opportunities

- All Setup tasks marked [P] can run in parallel (T003)
- All Polish tasks marked [P] can run in parallel (T014, T015, T016)
- T006 and T007 are in the same file but affect different sections — implement T006 first (simpler), then T007

---

## Parallel Example: Setup Phase

```bash
# T002 and T003 can run in parallel:
Task: T002 "Create extension/manifest.json"
Task: T003 "Create placeholder extension icons"
```

## Parallel Example: Polish Phase

```bash
# All polish tasks can run in parallel:
Task: T014 "Add IIFE wrapper to eme_hook.js"
Task: T015 "Add console logging with [UHDD] prefix"
Task: T016 "Handle multiple manifests per page"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (manifest + directory structure)
2. Complete Phase 2: Foundational (bridge + service worker skeleton)
3. Complete Phase 3: User Story 1 (EME hook + fetch interception + dispatch)
4. **STOP and VALIDATE**: Test on a Widevine DASH sample player
5. Load extension and verify daemon receives the payload

### Incremental Delivery

1. Complete Setup + Foundational → Extension loads cleanly
2. Add User Story 1 → Test DRM interception independently → **MVP ready**
3. Add User Story 2 (notifications) → Test success/failure notifications
4. Add User Story 3 (non-DRM .m3u8) → Test HLS interception
5. Polish → Edge cases, logging, IIFE wrapper
6. Each story adds visible value on top of the previous

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Manual E2E testing replaces automated unit tests (justified in plan.md Complexity Tracking)
- The extension has NO build step — all files are plain JavaScript loaded directly by Chrome
- T007 (EME hook) is the most complex task — KID extraction from PSSH and KEY extraction from Widevine license response require careful byte-level parsing
