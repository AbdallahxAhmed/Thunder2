# Quickstart: Native Download Hijacker

## Prerequisites

- Chrome 102+ with Manifest V3 support
- Thunder daemon running at `http://localhost:8000`
- aria2c daemon running with `--enable-rpc=true`
- Extension loaded unpacked from `extension/` directory

## Testing the Download Hijacker

1. **Load the updated extension**:
   ```bash
   # Navigate to chrome://extensions
   # Click "Load unpacked" → select the `extension/` directory
   # Verify the "downloads" permission is accepted
   ```

2. **Start the daemon stack**:
   ```bash
   # Terminal 1: aria2c
   aria2c --enable-rpc=true --rpc-listen-all=false --rpc-listen-port=6800

   # Terminal 2: Thunder daemon
   uvicorn src.main:app --host 0.0.0.0 --port 8000
   ```

3. **Trigger a download**:
   - Navigate to any page with a direct download link (e.g., a Linux ISO mirror)
   - Click the download link
   - Expected: Chrome's native download bar does NOT appear
   - Expected: Chrome notification "Thunder: Download Queued" appears
   - Expected: aria2 begins the download (check via `aria2c` terminal output)

4. **Verify anti-loop guard**:
   - Navigate to `http://localhost:8000/api/health`
   - If the page triggers a download, it should NOT be intercepted
   - Downloads from `localhost` are always allowed through

5. **Verify offline fallback**:
   - Stop the Thunder daemon
   - Click a download link
   - Expected: Chrome's native download proceeds normally
   - Expected: Chrome notification "Thunder: Backend Offline" appears

## Troubleshooting

- **Downloads not being intercepted**: Check that `"downloads"` is in `manifest.json` permissions
- **Cookies not captured**: Verify `host_permissions` includes `*://*/*`
- **Anti-loop guard too aggressive**: Check the console for `[Thunder SW] Skipping localhost download`
