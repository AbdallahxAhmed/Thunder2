# Contract: Download Hijack Payload

**Date**: 2026-04-27
**Endpoint**: `POST /api/download`
**Direction**: Extension → Daemon

## Request Schema (Hijacked Download)

```json
{
  "url": "https://example.com/file.iso",
  "referer": "https://example.com/downloads",
  "user_agent": "Mozilla/5.0 ...",
  "cookies": "session=abc123; token=xyz789",
  "engine": "aria2"
}
```

| Field        | Type   | Required | Description                                         |
|--------------|--------|----------|-----------------------------------------------------|
| `url`        | string | **yes**  | The file URL to download                            |
| `referer`    | string | no       | Referer header from the originating page             |
| `user_agent` | string | no       | Browser User-Agent string                           |
| `cookies`    | string | no       | Serialized cookies for the download domain           |
| `engine`     | string | no       | Engine override — `"aria2"` for hijacked downloads   |

### Validation Rules

- `url` must start with `http://`, `https://`, `ftp://`, or `magnet:`
- `engine`, if provided, must be one of: `"aria2"`, `"ytdlp"`, `"m3u8"`
- `cookies` is a semicolon-separated `name=value` string (standard HTTP cookie format)
- `referer` should be a valid URL; no validation enforced

## Response Schema (Unchanged)

```json
{
  "id": "uuid-string",
  "status": "queued",
  "engine": "aria2",
  "message": "Download request accepted"
}
```

HTTP 202 Accepted on success.

## Error Responses

| HTTP Status | Error Code           | When                                    |
|-------------|----------------------|-----------------------------------------|
| 422         | `VALIDATION_ERROR`   | Invalid URL, invalid engine name        |
| 503         | `ENGINE_UNAVAILABLE` | aria2 daemon is not running             |

## Anti-Loop Contract (Extension ↔ Extension)

The extension MUST NOT dispatch downloads matching:
- `url` hostname is `localhost` or `127.0.0.1`
- `url` is in the `dispatchedUrls` set (recently sent to daemon)
- `url` ends with `.mpd` or `.m3u8` (handled by content script pipeline)
