# API Contract: Unified Headless Download Daemon (Thunder)

**Date**: 2026-04-26
**Base URL**: `http://localhost:8000`
**Content-Type**: `application/json` (all requests and responses)

## Endpoints

### POST /api/download

Submit a new download request. The daemon classifies the URL and dispatches
it to the appropriate engine. Returns immediately with a job ID.

**Request Body**:

```json
{
  "url": "https://example.com/file.zip",
  "cookies": "session=abc123; token=xyz",
  "user_agent": "Mozilla/5.0 ...",
  "drm_keys": "abcdef1234567890:fedcba0987654321"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `url` | string | Yes | Download URL |
| `cookies` | string | No | Raw cookie header |
| `user_agent` | string | No | Custom User-Agent |
| `drm_keys` | string | No | `KID:KEY` hex pair |

**Response 202 Accepted**:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "status": "queued",
  "engine": "aria2",
  "message": "Download request accepted"
}
```

**Response 422 Unprocessable Entity** (validation error):

```json
{
  "error_code": "VALIDATION_ERROR",
  "message": "Invalid URL format",
  "details": [
    {
      "field": "url",
      "message": "URL must include a scheme (http/https/ftp/magnet)"
    }
  ]
}
```

**Response 503 Service Unavailable** (engine not available):

```json
{
  "error_code": "ENGINE_UNAVAILABLE",
  "message": "aria2 daemon is not reachable",
  "engine": "aria2"
}
```

---

### GET /api/download/{id}

Query the status and progress of a previously submitted download.

**Path Parameters**:

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | string (UUID) | Download job ID |

**Response 200 OK**:

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "url": "https://example.com/file.zip",
  "engine": "aria2",
  "status": "downloading",
  "progress": 45.2,
  "speed": "12.5 MB/s",
  "output_path": null,
  "file_size": null,
  "error": null,
  "created_at": "2026-04-26T15:30:00Z",
  "updated_at": "2026-04-26T15:31:15Z"
}
```

**Response 200 OK** (completed):

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "url": "https://example.com/file.zip",
  "engine": "aria2",
  "status": "completed",
  "progress": 100.0,
  "speed": null,
  "output_path": "downloads/file.zip",
  "file_size": 104857600,
  "error": null,
  "created_at": "2026-04-26T15:30:00Z",
  "updated_at": "2026-04-26T15:35:42Z"
}
```

**Response 404 Not Found**:

```json
{
  "error_code": "JOB_NOT_FOUND",
  "message": "No download job found with ID: invalid-uuid"
}
```

---

### GET /api/health

Check the daemon's health and engine availability.

**Response 200 OK**:

```json
{
  "status": "healthy",
  "uptime_seconds": 3600,
  "engines": [
    {
      "name": "aria2",
      "available": true,
      "version": "1.37.0",
      "error": null
    },
    {
      "name": "ytdlp",
      "available": true,
      "version": "2025.12.01",
      "error": null
    },
    {
      "name": "m3u8",
      "available": false,
      "version": null,
      "error": "N_m3u8DL-RE binary not found on PATH"
    }
  ]
}
```

**Response 503 Service Unavailable** (no engines available):

```json
{
  "status": "degraded",
  "uptime_seconds": 3600,
  "engines": [
    {
      "name": "aria2",
      "available": false,
      "version": null,
      "error": "aria2 RPC unreachable at http://localhost:6800/jsonrpc"
    }
  ]
}
```

---

## Error Response Format

All error responses follow a consistent structure:

```json
{
  "error_code": "MACHINE_READABLE_CODE",
  "message": "Human-readable explanation",
  "details": []
}
```

| Error Code | HTTP Status | Description |
|------------|-------------|-------------|
| `VALIDATION_ERROR` | 422 | Request payload failed validation |
| `JOB_NOT_FOUND` | 404 | Download ID does not exist |
| `ENGINE_UNAVAILABLE` | 503 | Target engine is not operational |
| `DISK_FULL` | 507 | Output directory has insufficient space |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Request/Response Headers

- `Content-Type: application/json` — required for POST requests
- `X-Request-ID` — optional client-provided correlation ID; echoed in response and logs
