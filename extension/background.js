/**
 * Thunder Service Worker — Background Script
 * Manages per-tab interception buffers, dispatches to daemon, shows notifications.
 * Implements zero-latency pre-fetching of format info for supported media sites.
 */

const DAEMON_URL = "http://localhost:8000/api/download";
const DAEMON_INFO_URL = "http://localhost:8000/api/info";
const DAEMON_WS_URL = "ws://localhost:8000/api/ws/events";
const DAEMON_API_URL = "http://localhost:8000/api";
const LOG = "[Thunder SW]";

// ─── WebSocket Event Bus ────────────────────────────────────────────────

let ws = null;
let wsReconnectTimer = null;
let wsKeepAliveTimer = null;
let wsBackoffMs = 1000;

function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  
  console.log(`${LOG} Connecting to Event Bus...`);
  ws = new WebSocket(DAEMON_WS_URL);
  
  ws.onopen = () => {
    console.log(`${LOG} Event Bus connected`);
    wsBackoffMs = 1000; // reset backoff
    if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
    
    // Prevent SW from sleeping via keep-alive ping
    if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer);
    wsKeepAliveTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Dummy ping to keep SW active and connection open (read-only enforced on backend)
        ws.send(JSON.stringify({ type: "ping" }));
      }
    }, 25000);
  };
  
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      // Broadcast to all active content scripts
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => {
          chrome.tabs.sendMessage(tab.id, { type: "WS_EVENT", payload: data }).catch(() => {});
        });
      });
    } catch (e) {
      console.error(`${LOG} WS parse error:`, e);
    }
  };
  
  ws.onclose = () => {
    console.log(`${LOG} Event Bus disconnected. Reconnecting in ${wsBackoffMs}ms...`);
    if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer);
    ws = null;
    wsReconnectTimer = setTimeout(connectWebSocket, wsBackoffMs);
    wsBackoffMs = Math.min(wsBackoffMs * 2, 30000);
  };
  
  ws.onerror = (err) => {
    // onclose will handle reconnect
  };
}

// Init WS
connectWebSocket();

// ─── Cookie Helper (IDM-style seamless injection) ────────────────────────

async function getCookiesForUrl(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    // Return full cookie objects for Netscape cookie file generation
    return cookies.map(c => ({
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      expirationDate: c.expirationDate || 0
    }));
  } catch (e) {
    console.warn(`${LOG} Failed to get cookies for ${url}:`, e);
    return [];
  }
}

// ─── Anti-Loop Guard ────────────────────────────────────────────────────

// URLs recently dispatched — skip if Chrome fires onCreated for them
const dispatchedDownloadUrls = new Set();

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
      drmHint: false,
      dispatchedUrls: new Set(),
    });
  }
  return tabBuffers.get(tabId);
}

// ─── Format Info Cache ────────────────────────────────────────────────
// Keyed by tabId → { url, data, ts, status }
// status: "ready" | "fetching" | "error"

const formatCache = new Map();
const CACHE_TTL_MS = 300_000;

function isCacheMatch(entry, url, drmHint) {
  return entry && entry.url === url && entry.drmHint === drmHint;
}

function isCacheFresh(entry) {
  return entry && entry.status === "ready" && (Date.now() - entry.ts) < CACHE_TTL_MS;
}



// ─── Dispatch to Thunder Daemon ──────────────────────────────────────────

async function dispatchToThunder(tabId) {
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

  if (buffer.drmHint) {
    payload.drm_hint = true;
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
        title: "Thunder: Download Queued",
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
      title: "Thunder: Backend Offline",
      message: "Could not reach Thunder daemon at localhost:8000",
    });
  }
}

// ─── Tab Lifecycle ────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabBuffers.delete(tabId);
  formatCache.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // SPA URL change — invalidate stale cache
  if (changeInfo.url && tab.url) {
    const cached = formatCache.get(tabId);
    if (cached && cached.url !== tab.url) {
      console.log(`${LOG} URL changed for tab ${tabId}, invalidating cache`);
      formatCache.delete(tabId);
    }
    return;
  }

  if (changeInfo.status === "loading") {
    tabBuffers.delete(tabId);
    formatCache.delete(tabId);
  }
});



// ─── Unified Message Handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle messages from content scripts
  if (sender.tab && sender.tab.id) {
    const tabId = sender.tab.id;
    const buffer = getBuffer(tabId);

    if (message.type === "manifest") {
      console.log(`${LOG} [tab ${tabId}] m3u8 manifest cached (no auto-dispatch): ${message.url}`);
      buffer.manifestUrl = message.url;
      buffer.drmHint = buffer.drmHint || Boolean(message.drmHint);
      if (message.title) buffer.title = message.title;
      // NOTE: NO dispatchToThunder() — user must explicitly trigger download
      return;
    } else if (message.type === "drm_package") {
      console.log(`${LOG} [tab ${tabId}] DRM package cached (no auto-dispatch)`);
      buffer.manifestUrl = message.url;
      buffer.pssh = message.pssh;
      buffer.licenseUrl = message.licenseUrl;
      buffer.licenseHeaders = message.licenseHeaders || {};
      if (message.drmKeys) buffer.drmKeys = message.drmKeys;
      buffer.drmHint = true;
      if (message.title) buffer.title = message.title;
      // NOTE: NO dispatchToThunder() — user must explicitly trigger download
      return;
    }
  }

  // Handle messages from the popup or content script
  if (message.type === "getFormats" || message.action === "GET_HYBRID_STREAMS" || message.action === "PRE_WARM_URL") {
    const tabId = message.tabId ?? sender.tab?.id;
    // Prefer the tab's main-frame URL (sender.tab.url) over message.url.
    // When the message originates from an iframe, message.url is the iframe's
    // own URL (e.g. geo.dailymotion.com/player/…) which yt-dlp cannot handle.
    // sender.tab.url is always the real top-level page URL.
    // For popup messages sender.tab is undefined, so we fall back to message.url.
    const url = sender.tab?.url ?? message.url;

    if (!tabId || !url) {
      sendResponse({ ok: false, error: "Missing tab context" });
      return true;
    }

    const cached = formatCache.get(tabId);
    const buffer = tabBuffers.get(tabId);
    const hasRawStream = buffer && !!buffer.manifestUrl;
    const drmHint = buffer ? buffer.drmHint : false;

    function sendHybridResponse(data, fromCache) {
      const payload = {
        title: data?.title || buffer?.title || "Unknown Title",
        url: url,
        options: data?.options ? [...data.options] : []
      };

      if (hasRawStream) {
        payload.options.unshift({
          type: "video",
          format_id: "raw-intercept",
          label: "🎬 Master Stream (Adaptive)",
          badge: "RAW",
          vcodec: "unknown",
          acodec: "unknown",
          ext: (/\.(m3u8|mpd|ts|mp4)$/i.exec(buffer.manifestUrl.split('?')[0]) || ["", "m3u8"])[1]
        });
      }

      sendResponse({ ok: true, data: payload, fromCache });
    }

    // ── Cache HIT (ready + same URL + fresh) ─────────────────────────
    if (isCacheMatch(cached, url, drmHint) && isCacheFresh(cached)) {
      console.log(`${LOG} Format cache HIT for tab ${tabId}`);
      sendHybridResponse(cached.data, true);
      return true;
    }

    // ── Cache is currently fetching — poll at 100ms for fast resolution ─
    if (isCacheMatch(cached, url, drmHint) && cached.status === "fetching") {
      console.log(`${LOG} Format cache PENDING for tab ${tabId}, waiting…`);
      let waited = 0;
      const poll = setInterval(() => {
        waited += 100;
        const entry = formatCache.get(tabId);
        if (!entry || waited > 30_000) {
          clearInterval(poll);
          if (hasRawStream) sendHybridResponse(null, false);
          else sendResponse({ ok: false, error: "Timeout waiting for formats" });
        } else if (entry.status === "ready") {
          clearInterval(poll);
          sendHybridResponse(entry.data, true);
        } else if (entry.status === "error") {
          clearInterval(poll);
          if (hasRawStream) sendHybridResponse(null, false);
          else sendResponse({ ok: false, error: "Format fetch failed" });
        }
      }, 100);
      return true; // keep channel open
    }

    // ── Cache MISS — fetch now ───────────────────────────────────────
    // Pre-filter: skip non-media URLs that will always fail
    const SKIP_PREFIXES = ["chrome://", "chrome-extension://"];
    const SKIP_SUFFIXES = [".jpg", ".png", ".css"];
    const urlLower = url.toLowerCase();
    if (SKIP_PREFIXES.some(p => urlLower.startsWith(p)) ||
        SKIP_SUFFIXES.some(s => urlLower.endsWith(s))) {
      console.log(`${LOG} Skipping unsupported URL: ${url}`);
      if (hasRawStream) sendHybridResponse(null, false);
      else sendResponse({ ok: false, error: "Unsupported URL" });
      return true;
    }

    console.log(`${LOG} Format cache MISS for tab ${tabId}, fetching…`);
    formatCache.set(tabId, { url, data: null, ts: 0, status: "fetching", drmHint });
    
    getCookiesForUrl(url).then(cookieObjects => {
      // POST cookies as JSON body instead of header to avoid size limits
      const infoPayload = {
        url: url,
        drm_hint: drmHint,
        user_agent: navigator.userAgent,
        cookies: cookieObjects.length > 0 ? cookieObjects : undefined
      };
      
      fetch(DAEMON_INFO_URL, { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(infoPayload)
      })
        .then(resp => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return resp.json();
        })
        .then(data => {
          formatCache.set(tabId, { url, data, ts: Date.now(), status: "ready", drmHint });
          sendHybridResponse(data, false);
        })
        .catch(err => {
          console.error(`${LOG} /api/info failed:`, err);
          formatCache.set(tabId, { url, data: null, ts: Date.now(), status: "error", drmHint });
          if (hasRawStream) sendHybridResponse(null, false);
          else sendResponse({ ok: false, error: err.message });
        });
    });

    return true; // keep channel open for async response
  }

  // Handle instant raw stream request for predictive UI rendering
  if (message.action === "GET_RAW_STREAM") {
    const tabId = sender.tab?.id;
    const buffer = tabBuffers.get(tabId);
    if (buffer && buffer.manifestUrl) {
      sendResponse({ ok: true, data: { url: buffer.manifestUrl, title: buffer.title } });
    } else {
      sendResponse({ ok: false });
    }
    return;
  }

  // Handle download triggers from content script (Dumb UI enforcement)
  if (message.action === "TRIGGER_DOWNLOAD") {
    const payload = message.payload;
    if (!payload || !payload.url) {
      sendResponse({ ok: false, error: "Missing payload or url" });
      return true;
    }

    // Override URL with the tab's top-level page URL so that content scripts
    // running inside player iframes (e.g. geo.dailymotion.com/player/…) never
    // submit the embed URL to the daemon — same pattern as GET_HYBRID_STREAMS.
    if (payload.format_id !== "raw-intercept" && sender.tab?.url) {
      payload.url = sender.tab.url;
    }

    if (payload.format_id === "raw-intercept") {
      const tabId = sender.tab?.id;
      const buffer = tabBuffers.get(tabId);
      if (!buffer || !buffer.manifestUrl) {
        sendResponse({ ok: false, error: "Raw stream buffer expired" });
        return true;
      }
      if (sender.tab?.url) payload.page_url = sender.tab.url;
      payload.url = buffer.manifestUrl;
      delete payload.format_id;
      
      if (buffer.pssh && buffer.licenseUrl) {
        payload.pssh = buffer.pssh;
        payload.license_url = buffer.licenseUrl;
        payload.license_headers = buffer.licenseHeaders || {};
      }
      if (buffer.drmKeys) {
        payload.drm_keys = buffer.drmKeys;
      }
      if (buffer.drmHint) payload.drm_hint = true;
      if (!payload.title && buffer.title) payload.title = buffer.title;
    }

    console.log(`${LOG} Triggering download from content script:`, payload);
    
    // IDM-style: inject browser cookies and user-agent into the payload as objects
    payload.user_agent = navigator.userAgent;
    const targetUrl = payload.page_url || payload.url;
    getCookiesForUrl(targetUrl).then(cookieObjects => {
      if (cookieObjects.length > 0) payload.cookies = cookieObjects;
      
      return fetch(DAEMON_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    })
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    })
    .then(data => {
      const engine = data.engine || "unknown";
      console.log(`${LOG} Download queued → ${engine}`);
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "Thunder: Download Queued",
        message: `${payload.url.substring(0, 50)}… → ${engine}`,
      });
      sendResponse({ ok: true, data });
    })
    .catch(err => {
      console.error(`${LOG} Download trigger failed:`, err);
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "Thunder: Backend Offline",
        message: "Could not reach Thunder daemon at localhost:8000",
      });
      sendResponse({ ok: false, error: err.message });
    });

    return true; // keep channel open for async response
  }
  
  // Handle REST Actions from Dumb UI
  if (["ACTION_PAUSE", "ACTION_RESUME", "ACTION_CANCEL"].includes(message.action)) {
    const jobId = message.jobId;
    if (!jobId) {
      sendResponse({ ok: false, error: "Missing jobId" });
      return true;
    }
    
    const command = message.action.split("_")[1].toLowerCase(); // pause, resume, cancel
    
    fetch(`${DAEMON_API_URL}/jobs/${jobId}/${command}`, {
      method: "POST"
    })
    .then(resp => {
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return resp.json();
    })
    .then(data => sendResponse({ ok: true, data }))
    .catch(err => {
      console.error(`${LOG} REST action ${command} failed:`, err);
      sendResponse({ ok: false, error: err.message });
    });
    
    return true;
  }
});

// ─── Native Download Hijacker ─────────────────────────────────────────

chrome.downloads.onCreated.addListener(async (downloadItem) => {
  const url = downloadItem.url;
  
  // 1. Anti-Loop Guard
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1") {
      console.log(`${LOG} Skipping localhost download: ${url}`);
      return;
    }
  } catch (e) {
    // Invalid URL, let Chrome handle it
    return;
  }

  if (dispatchedDownloadUrls.has(url)) {
    console.log(`${LOG} Skipping already dispatched download: ${url}`);
    return;
  }

  // 2. Skip streaming manifests (handled by content script)
  const pathLower = url.toLowerCase();
  if (pathLower.includes(".mpd") || pathLower.includes(".m3u8")) {
    return;
  }

  console.log(`${LOG} Intercepting native download: ${url}`);

  // 3. Extract metadata
   const referer = downloadItem.referrer || "";
    const userAgent = navigator.userAgent;
    const cookieObjects = await getCookiesForUrl(url);

  // 4. Build payload
  const payload = {
    url: url,
    engine: "aria2"
  };

  if (referer) payload.referer = referer;
  if (userAgent) payload.user_agent = userAgent;
  if (cookieObjects.length > 0) payload.cookies = cookieObjects;

  // 5. Dispatch to daemon
  try {
    const response = await fetch(DAEMON_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (response.ok) {
      const data = await response.json();
      console.log(`${LOG} Hijacked → ${data.engine}`);
      
      // Cancel native download ONLY after successful dispatch
      chrome.downloads.cancel(downloadItem.id);
      chrome.downloads.erase({ id: downloadItem.id });
      
      // Add to anti-loop guard
      dispatchedDownloadUrls.add(url);
      setTimeout(() => {
        dispatchedDownloadUrls.delete(url);
      }, 30000);

      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "Thunder: Download Hijacked",
        message: `${url.substring(0, 50)}… → ${data.engine}`,
      });
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`${LOG} Hijack failed, daemon unreachable:`, error);
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "Thunder: Backend Offline",
      message: "Could not reach Thunder daemon. Download proceeding natively.",
    });
    // We don't cancel the download, so it falls back to Chrome gracefully
  }
});
