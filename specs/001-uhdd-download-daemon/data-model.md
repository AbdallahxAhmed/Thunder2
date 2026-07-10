# Data Model: Unified Headless Download Daemon (UHDD)

**Date**: 2026-04-26
**Source**: [spec.md](spec.md) + [research.md](research.md)

## Entities

### DownloadRequest

Represents an incoming download submission from the browser extension.

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `url` | `str` | Yes | Must be a valid URL (http/https/ftp/magnet) |
| `cookies` | `str \| None` | No | Raw cookie header string |
| `user_agent` | `str \| None` | No | Custom User-Agent header value |
| `drm_keys` | `str \| None` | No | Format: `KID:KEY` (hex strings separated by colon) |

**Validation rules**:
- `url` must pass URL validation (scheme + host minimum).
- `drm_keys` if present must match pattern `^[a-fA-F0-9]+:[a-fA-F0-9]+$`.
- `cookies` and `user_agent` are pass-through strings with no format enforcement.

### DownloadJob

Represents an active or completed download tracked by the daemon.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `str (UUID4)` | Unique job identifier, returned at submission |
| `url` | `str` | Original URL from the request |
| `engine` | `str` | Assigned engine: `aria2`, `ytdlp`, or `m3u8` |
| `status` | `DownloadStatus` | Current state (see state machine below) |
| `progress` | `float \| None` | Percentage 0.0–100.0 (when available from engine) |
| `speed` | `str \| None` | Human-readable speed string (e.g., "12.5 MB/s") |
| `output_path` | `str \| None` | Final file path relative to `downloads/` |
| `file_size` | `int \| None` | Final file size in bytes |
| `error` | `str \| None` | Error message if status is `failed` |
| `created_at` | `datetime` | Timestamp when the job was created |
| `updated_at` | `datetime` | Timestamp of last status change |
| `aria2_gid` | `str \| None` | aria2-specific: the GID for RPC status polling |

### DownloadStatus (Enum)

```
queued → downloading → completed
                    → failed
```

| Value | Description |
|-------|-------------|
| `queued` | Job accepted, waiting for engine to pick up |
| `downloading` | Engine is actively processing the download |
| `completed` | Download finished successfully, file available |
| `failed` | Download failed; `error` field contains details |

**State transitions**:
- `queued` → `downloading`: Engine begins processing.
- `downloading` → `completed`: Engine reports success.
- `downloading` → `failed`: Engine reports error OR timeout.
- `queued` → `failed`: Engine unavailable at dispatch time.

No backward transitions. Terminal states: `completed`, `failed`.

### EngineHealth

Represents the health status of a download engine.

| Field | Type | Description |
|-------|------|-------------|
| `name` | `str` | Engine identifier: `aria2`, `ytdlp`, `m3u8` |
| `available` | `bool` | Whether the engine is operational |
| `version` | `str \| None` | Engine version string (if detectable) |
| `error` | `str \| None` | Reason for unavailability |

### Settings (Configuration)

| Field | Env Variable | Default | Description |
|-------|-------------|---------|-------------|
| `aria2_rpc_url` | `ARIA2_RPC_URL` | `http://localhost:6800/jsonrpc` | aria2 RPC endpoint |
| `aria2_rpc_secret` | `ARIA2_RPC_SECRET` | `""` | aria2 RPC auth token |
| `download_dir` | `DOWNLOAD_DIR` | `downloads` | Output directory for files |
| `log_dir` | `LOG_DIR` | `logs` | Log output directory |
| `log_level` | `LOG_LEVEL` | `INFO` | Logging verbosity |

## Relationships

```
DownloadRequest  ──creates──▶  DownloadJob
DownloadJob      ──uses──▶     Engine (aria2 | ytdlp | m3u8)
Engine           ──reports──▶  EngineHealth
```

- One `DownloadRequest` creates exactly one `DownloadJob`.
- Each `DownloadJob` is assigned to exactly one `Engine`.
- `EngineHealth` is independent per engine, checked at startup and on-demand via `/api/health`.
