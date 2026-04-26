<!--
Sync Impact Report
===================
- Version change: N/A (initial) → 1.0.0
- Added principles:
  - I. Headless-First
  - II. Smart Routing
  - III. DRM Pipeline Isolation
  - IV. API-Driven Architecture
  - V. Observability & Structured Logging
  - VI. Test-First Discipline
  - VII. Simplicity & YAGNI
- Added sections:
  - Technology Constraints
  - Development Workflow
  - Governance
- Templates requiring updates:
  - .specify/templates/plan-template.md — ✅ no updates needed (generic, already references constitution check)
  - .specify/templates/spec-template.md — ✅ no updates needed (generic template)
  - .specify/templates/tasks-template.md — ✅ no updates needed (generic template)
- Follow-up TODOs: None
-->

# Dark Downloader Constitution

## Core Principles

### I. Headless-First

Dark Downloader MUST operate as a fully headless service with zero GUI dependencies.
All user interaction MUST occur through APIs or CLI commands — never through
browser windows, desktop prompts, or interactive terminal wizards.

- The system MUST be deployable on any Linux server or container without a
  display server (X11/Wayland).
- All configuration MUST be expressible via environment variables, config files,
  or API payloads.
- Background operation is the default; foreground/interactive modes are
  explicitly out of scope.

**Rationale**: A headless architecture enables deployment on NAS devices,
Docker containers, and remote servers where no GUI is available.

### II. Smart Routing

The system MUST automatically route download requests to the correct backend
engine based on URL analysis and content type:

- **aria2** — direct file downloads (HTTP/HTTPS/FTP/BitTorrent/Magnet links).
  Communication MUST use aria2's JSON-RPC interface (`aria2.addUri`,
  `aria2.tellStatus`, etc.) over HTTP to `localhost:6800/jsonrpc`.
- **yt-dlp** — media extraction from supported sites (YouTube, Vimeo,
  and 1000+ extractors). yt-dlp MUST be imported as a Python module
  (`import yt_dlp`), never invoked via subprocess.
- **N_m3u8DL-RE** — Widevine/DRM-encrypted streams requiring `KID:KEY`
  decryption. Invoked via `subprocess.run` when DRM is detected.

Routing logic MUST be deterministic and testable: given a URL and metadata,
the chosen engine MUST be predictable without side effects.

**Rationale**: Each engine excels at a specific domain. Smart routing
delivers the best performance and compatibility without user intervention.

### III. DRM Pipeline Isolation

Widevine/DRM handling MUST be isolated in a dedicated pipeline that is
entirely separate from the standard download paths:

- DRM downloads require an explicit `KID:KEY` pair supplied by the caller.
- The system MUST NOT attempt to crack, brute-force, or circumvent DRM
  protections autonomously.
- `N_m3u8DL-RE` is the sole tool for DRM decryption and MUST be executed
  via subprocess with `--key`, `--save-dir`, `--save-name`, `--auto-select`,
  and `--del-after-done` flags.
- DRM pipeline failures MUST NOT cascade into or corrupt the standard
  download queue.

**Rationale**: Isolating DRM operations reduces blast radius, keeps the
core download path simple, and makes the legal boundary of the tool explicit.

### IV. API-Driven Architecture

All functionality MUST be exposed through a FastAPI-based REST API running
on `uvicorn`:

- Every download action (submit, cancel, status, retry) MUST have a
  corresponding API endpoint.
- Long-running downloads MUST execute as background tasks, returning an
  immediate acknowledgment with a tracking identifier.
- The API MUST use JSON request/response bodies exclusively.
- Errors MUST return structured JSON with machine-readable error codes and
  human-readable messages.

**Rationale**: An API-first design enables integration with external
orchestrators, web UIs, mobile apps, and automation scripts.

### V. Observability & Structured Logging

All components MUST produce structured log output (JSON format) to stderr:

- Every download lifecycle event (queued, started, progress, completed,
  failed, retried) MUST be logged with a correlation/download ID.
- aria2 RPC calls and responses MUST be logged at DEBUG level.
- yt-dlp progress hooks MUST emit structured progress events.
- N_m3u8DL-RE subprocess stdout/stderr MUST be captured and logged.
- Sensitive data (tokens, keys, credentials) MUST be redacted in all
  log output.

**Rationale**: Headless services are unobservable without logs. Structured
logging enables log aggregation, alerting, and post-mortem debugging.

### VI. Test-First Discipline

All new features MUST follow a test-first workflow:

- Unit tests MUST cover routing logic, URL classification, and
  configuration parsing.
- Integration tests MUST verify end-to-end flows for each download engine
  using mocked backends (mock aria2 RPC, mock yt-dlp extractor).
- Contract tests MUST validate API request/response schemas.
- Tests MUST be written before implementation (Red → Green → Refactor).
- The test suite MUST be runnable without network access or external
  services (all external calls mocked).

**Rationale**: A headless automated system has no user to catch regressions.
Tests are the only safety net.

### VII. Simplicity & YAGNI

Start with the simplest implementation that satisfies requirements:

- No plugin systems, no dynamic engine loading, no abstract factory
  patterns unless proven necessary by a concrete requirement.
- Three engines (aria2, yt-dlp, N_m3u8DL-RE) are the exhaustive set;
  adding a new engine requires a constitution amendment.
- Configuration MUST have sensible defaults; zero-config startup MUST
  be possible for the common case.
- Premature optimization is prohibited. Profile first, then optimize.

**Rationale**: Complexity is the primary enemy of a small, focused tool.
Every abstraction layer must earn its place.

## Technology Constraints

- **Language**: Python 3.11+
- **API Framework**: FastAPI + uvicorn
- **Download Engines**:
  - `aria2c` daemon with `--enable-rpc=true` and `--rpc-secret` token
  - `yt_dlp` Python module (direct import, no subprocess)
  - `N_m3u8DL-RE` binary (subprocess only, for DRM/Widevine)
- **HTTP Client**: `requests` for aria2 JSON-RPC communication
- **Storage**: Local filesystem (`downloads/` directory by default)
- **Containerization**: MUST be deployable as a Docker container
- **Platform**: Linux-first; macOS support is best-effort; Windows is
  out of scope

## Development Workflow

- **Branching**: Feature branches with descriptive names
  (`feature/smart-routing`, `fix/aria2-timeout`)
- **Commits**: Conventional Commits format
  (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- **Code Style**: PEP 8 enforced via linter; type hints MUST be used on
  all public function signatures
- **Dependencies**: Minimize external dependencies; every new dependency
  MUST be justified
- **Configuration Management**: Environment variables for secrets;
  TOML/YAML config files for non-sensitive settings

## Governance

This constitution is the supreme authority for all development decisions
in Dark Downloader. In case of conflict between this document and any
other specification, plan, or task, this constitution prevails.

- **Amendments**: Any change to this constitution MUST be documented with
  a version bump, rationale, and migration plan for affected components.
- **Versioning**: Constitution follows Semantic Versioning — MAJOR for
  principle removal/redefinition, MINOR for new principles/sections,
  PATCH for wording clarifications.
- **Compliance**: Every pull request and code review MUST verify
  adherence to all active principles. Violations MUST be flagged and
  resolved before merge.
- **Principle Disputes**: When a principle conflicts with a practical
  need, the resolution MUST be documented in a Complexity Tracking table
  (see plan template) with justification for the exception.

**Version**: 1.0.0 | **Ratified**: 2026-04-26 | **Last Amended**: 2026-04-26
