# Quickstart: Unified Headless Download Daemon (Thunder)

## Prerequisites

- **Python 3.11+**
- **aria2** installed and running with RPC enabled:
  ```bash
  aria2c --enable-rpc=true --rpc-listen-all=false --rpc-secret=YOUR_TOKEN
  ```
- **ffmpeg** installed (required by yt-dlp for muxing)
- **N_m3u8DL-RE** binary on PATH (optional — only needed for DRM streams)

## Install

```bash
# Clone the repository
git clone https://github.com/your-org/thunder.git
cd thunder

# Create virtual environment
python3.11 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

## Configure

The daemon reads configuration from environment variables. All have sensible defaults:

```bash
# Optional — only set if you changed the defaults
export ARIA2_RPC_URL="http://localhost:6800/jsonrpc"
export ARIA2_RPC_SECRET="YOUR_TOKEN"
export DOWNLOAD_DIR="downloads"
export LOG_DIR="logs"
export LOG_LEVEL="INFO"
```

## Run

```bash
# Start the daemon
uvicorn src.main:app --host 0.0.0.0 --port 8000

# Or with auto-reload during development
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

The daemon is now listening at `http://localhost:8000`.

## Verify

```bash
# Check health
curl http://localhost:8000/api/health | python3 -m json.tool
```

Expected output:
```json
{
  "status": "healthy",
  "engines": [
    {"name": "aria2", "available": true},
    {"name": "ytdlp", "available": true},
    {"name": "m3u8", "available": true}
  ]
}
```

## Usage Examples

### Download a standard file (→ aria2)

```bash
curl -X POST http://localhost:8000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/archive.zip"}'
```

Response:
```json
{"id": "abc-123", "status": "queued", "engine": "aria2"}
```

### Download a YouTube video (→ yt-dlp)

```bash
curl -X POST http://localhost:8000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"}'
```

### Download a DRM stream (→ N_m3u8DL-RE)

```bash
curl -X POST http://localhost:8000/api/download \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/stream.mpd", "drm_keys": "abcdef:123456"}'
```

### Check download status

```bash
curl http://localhost:8000/api/download/abc-123
```

## Run Tests

```bash
# Run all tests (no network required — all engines mocked)
pytest tests/ -v

# Run with coverage
pytest tests/ -v --cov=src --cov-report=term-missing
```

## Directory Layout

After running, the project creates:

```
downloads/    # Completed files appear here
logs/         # Structured JSON logs
```
