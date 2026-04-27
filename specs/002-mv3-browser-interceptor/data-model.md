# Data Model: Native Download Hijacker (v3 Additions)

**Date**: 2026-04-27

## Extension-Side Entities

### DownloadItem (Chrome API — read-only)

The `chrome.downloads.onCreated` event provides a `DownloadItem` with:

| Field       | Type     | Description                                |
|-------------|----------|--------------------------------------------|
| `id`        | number   | Chrome's internal download ID              |
| `url`       | string   | The URL being downloaded                   |
| `referrer`  | string   | Referer URL for the download               |
| `filename`  | string   | Suggested filename (may be empty)          |
| `mime`      | string   | MIME type of the download                  |
| `state`     | string   | `"in_progress"`, `"interrupted"`, `"complete"` |
| `tabId`     | number   | Tab that initiated the download (-1 if unknown) |

### Anti-Loop Guard State

| Field             | Type         | Description                                         |
|-------------------|--------------|-----------------------------------------------------|
| `dispatchedUrls`  | `Set<string>` | URLs recently dispatched to daemon — skip on `onCreated` |

## Daemon-Side Model Changes

### DownloadRequest (Pydantic — updated fields)

New optional fields added to existing `DownloadRequest`:

| Field        | Type             | Default | Description                                    |
|--------------|------------------|---------|------------------------------------------------|
| `referer`    | `Optional[str]`  | `None`  | HTTP Referer header for the download           |
| `engine`     | `Optional[str]`  | `None`  | Explicit engine override (`"aria2"`, `"ytdlp"`, `"m3u8"`) |

Existing fields already present and reused:

| Field        | Type             | Description                                    |
|--------------|------------------|------------------------------------------------|
| `url`        | `str`            | Download URL (required)                        |
| `cookies`    | `Optional[str]`  | Raw cookie header string                       |
| `user_agent` | `Optional[str]`  | Custom User-Agent string                       |

### Router Changes

The `classify()` function signature does not change. Instead, the caller (`main.py`) checks for `request.engine` **before** calling `classify()`. If `engine` is set and is a valid engine name, it is used directly.

Valid engine names: `"aria2"`, `"ytdlp"`, `"m3u8"`

## Data Flow

```text
Chrome downloads.onCreated
  ├── downloadItem.url       ──┐
  ├── downloadItem.referrer  ──┤
  ├── navigator.userAgent    ──┤ → POST /api/download
  ├── chrome.cookies.getAll  ──┤   {url, referer, user_agent, cookies, engine: "aria2"}
  └── engine: "aria2"        ──┘
                                     │
                                     ▼
                               main.py submit_download()
                                 │ if request.engine → use directly
                                 │ else → classify(url, drm_keys, pssh, license_url)
                                     │
                                     ▼
                               aria2_client.execute()
                                 │ add_download(url, user_agent, cookies, referer)
                                     │
                                     ▼
                               aria2c daemon (RPC)
```
