/**
 * UHDD Service Worker — Background Script
 * Manages per-tab interception buffers, dispatches to daemon, shows notifications.
 */

const DAEMON_URL = "http://localhost:8000/api/download";
const LOG = "[UHDD SW]";

// ─── Per-Tab Buffer ───────────────────────────────────────────────────

const tabBuffers = new Map();

function getBuffer(tabId) {
  if (!tabBuffers.has(tabId)) {
    tabBuffers.set(tabId, {
      manifestUrl: null,
      pssh: null,
      licenseUrl: null,
      licenseHeaders: {},
      title: null,
      dispatchedUrls: new Set(),
    });
  }
  return tabBuffers.get(tabId);
}

// ─── Dispatch to UHDD Daemon ──────────────────────────────────────────

async function dispatchToUHDD(tabId) {
  const buffer = tabBuffers.get(tabId);
  if (!buffer || !buffer.manifestUrl) return;

  const url = buffer.manifestUrl;

  // Deduplication
  if (buffer.dispatchedUrls.has(url)) {
    console.log(`${LOG} Already dispatched, skipping: ${url}`);
    return;
  }

  // Build payload
  const payload = { url };

  if (buffer.pssh && buffer.licenseUrl) {
    // License proxy mode — daemon will negotiate keys
    payload.pssh = buffer.pssh;
    payload.license_url = buffer.licenseUrl;
    payload.license_headers = buffer.licenseHeaders || {};
  }

  // Include page title for clean filenames
  if (buffer.title) {
    payload.title = buffer.title;
  }

  buffer.dispatchedUrls.add(url);
  console.log(`${LOG} Dispatching:`, JSON.stringify(payload, null, 2));

  try {
    const response = await fetch(DAEMON_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const data = await response.json();
      const engine = data.engine || "unknown";
      console.log(`${LOG} Queued → ${engine}`);
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "UHDD: Download Queued",
        message: `${url.substring(0, 50)}… → ${engine}`,
      });
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`${LOG} Daemon unreachable:`, error);
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "UHDD: Backend Offline",
      message: "Could not reach UHDD daemon at localhost:8000",
    });
  }
}

// ─── Message Handler ──────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!sender.tab || !sender.tab.id) return;
  const tabId = sender.tab.id;
  const buffer = getBuffer(tabId);

  if (message.type === "manifest") {
    // Non-DRM .m3u8 — dispatch immediately
    console.log(`${LOG} [tab ${tabId}] m3u8 manifest: ${message.url}`);
    buffer.manifestUrl = message.url;
    if (message.title) buffer.title = message.title;
    dispatchToUHDD(tabId);

  } else if (message.type === "drm_package") {
    // Full DRM package from eme_hook.js
    console.log(`${LOG} [tab ${tabId}] DRM package received`);
    buffer.manifestUrl = message.url;
    buffer.pssh = message.pssh;
    buffer.licenseUrl = message.licenseUrl;
    buffer.licenseHeaders = message.licenseHeaders || {};
    if (message.title) buffer.title = message.title;
    dispatchToUHDD(tabId);
  }
});

// ─── Tab Cleanup ──────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabBuffers.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabBuffers.delete(tabId);
  }
});
