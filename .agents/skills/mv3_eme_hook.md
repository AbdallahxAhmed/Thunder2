# Skill: MV3 EME Hooking & UHDD Integration
This skill defines how to intercept DRM keys (`KID:KEY`) and manifest URLs (`.mpd`/`.m3u8`) in a Chrome Manifest V3 extension and forward them to a local daemon.

## Architecture Rules
1. **Manifest V3**: Must use `"manifest_version": 3`.
2. **Main World Injection**: To intercept DRM, a hook must be injected into the page's execution environment. Use content scripts with `"world": "MAIN"` (supported in modern MV3) to override `navigator.requestMediaKeySystemAccess`.
3. **The Hook Logic**: The injected script must intercept the `MediaKeySession` to extract the `KID` (from the initData) and the `KEY` (from the license response), and sniff network requests (via `XMLHttpRequest` or `fetch` overrides) to capture the `.mpd` URL.
4. **Daemon Communication**: The extension must send a `POST` request to `http://localhost:8000/api/download` with the JSON payload: `{"url": "...", "drm_keys": "KID:KEY"}`.
5. **Permissions**: Requires `"activeTab"`, `"scripting"`, and `"host_permissions": ["*://*/*", "http://localhost:8000/*"]`.