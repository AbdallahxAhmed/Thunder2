/**
 * Thunder Service Worker — Background Script
 * Manages per-tab interception buffers, dispatches to daemon, shows notifications.
 * Implements zero-latency pre-fetching of format info for supported media sites.
 */

const DAEMON_URL = "http://localhost:8000/api/download";
const DAEMON_INFO_URL = "http://localhost:8000/api/info";
const LOG = "[Thunder SW]";

let apiToken = "";

async function getAuthHeaders() {
  if (!apiToken) {
    try {
      const response = await fetch("http://localhost:8000/api/auth/token");
      if (response.ok) {
        const data = await response.json();
        apiToken = data.token;
        chrome.storage.local.set({ thunder_api_token: apiToken });
        console.log(`${LOG} Retrieved API Token successfully`);
      }
    } catch (e) {
      console.error(`${LOG} Failed to fetch API Token:`, e);
    }
  }
  return {
    "Content-Type": "application/json",
    ...(apiToken ? { "Authorization": `Bearer ${apiToken}` } : {})
  };
}

// Retrieve token on startup/install
chrome.runtime.onStartup.addListener(getAuthHeaders);
chrome.runtime.onInstalled.addListener(getAuthHeaders);
// Try loading from storage on load
chrome.storage.local.get("thunder_api_token", (res) => {
  if (res && res.thunder_api_token) {
    apiToken = res.thunder_api_token;
  } else {
    getAuthHeaders();
  }
});

// ─── Context Menu ────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-course-dashboard",
    title: "Open Course Downloader Dashboard",
    contexts: ["action", "page"]
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === "open-course-dashboard") {
    chrome.tabs.create({ url: "http://localhost:8000/dashboard/index.html" });
  }
});

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
    const authHeaders = await getAuthHeaders();
    const response = await fetch(DAEMON_URL, {
      method: "POST",
      headers: authHeaders,
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
    
    // Only clear the stream buffer if the new URL is different from the page where it was captured
    const buffer = tabBuffers.get(tabId);
    if (buffer && buffer.pageUrl && buffer.pageUrl !== tab.url) {
      console.log(`${LOG} URL changed to ${tab.url}, different from capture page ${buffer.pageUrl}. Clearing stream buffer.`);
      tabBuffers.delete(tabId);
    }
    return;
  }
});



// ─── Unified Message Handler ──────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle messages from content scripts
  if (sender.tab && sender.tab.id) {
    const tabId = sender.tab.id;
    
    if (message.action === "CLEAR_BUFFER") {
      tabBuffers.delete(tabId);
      formatCache.delete(tabId);
      console.log(`${LOG} [tab ${tabId}] Cleared stream buffer explicitly`);
      sendResponse({ ok: true });
      return true;
    }

    const buffer = getBuffer(tabId);

    if (message.type === "manifest") {
      console.log(`${LOG} [tab ${tabId}] m3u8 manifest cached (no auto-dispatch): ${message.url}`);
      buffer.manifestUrl = message.url;
      buffer.pageUrl = sender.tab.url;
      buffer.drmHint = buffer.drmHint || Boolean(message.drmHint);
      if (message.title) buffer.title = message.title;
      // NOTE: NO dispatchToUHDD() — user must explicitly trigger download
      return;
    } else if (message.type === "drm_package") {
      console.log(`${LOG} [tab ${tabId}] DRM package cached (no auto-dispatch)`);
      buffer.manifestUrl = message.url;
      buffer.pageUrl = sender.tab.url;
      buffer.pssh = message.pssh;
      buffer.licenseUrl = message.licenseUrl;
      buffer.licenseHeaders = message.licenseHeaders || {};
      if (message.drmKeys) buffer.drmKeys = message.drmKeys;
      buffer.drmHint = true;
      if (message.title) buffer.title = message.title;
      // NOTE: NO dispatchToUHDD() — user must explicitly trigger download
      return;
    }
  }

  // Handle messages from the popup or content script
  if (message.type === "getFormats" || message.action === "GET_HYBRID_STREAMS" || message.action === "PRE_WARM_URL") {
    const tabId = message.tabId ?? sender.tab?.id;
    let url = message.url;
    if (sender.tab && sender.tab.url) {
      const isMainFrame = sender.frameId === 0;
      if (isMainFrame || !url) {
        url = sender.tab.url;
      }
    }

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
    const pageUrl = sender.tab?.url;
    const userAgent = navigator.userAgent;

    const doFetch = async (cookieList) => {
      console.log(`${LOG} Format cache MISS for tab ${tabId}, fetching…`);
      formatCache.set(tabId, { url, data: null, ts: 0, status: "fetching", drmHint });
      
      const payload = {
        url: url,
        drm_hint: drmHint,
        cookies: cookieList || null,
        user_agent: userAgent
      };

      const authHeaders = await getAuthHeaders();
      fetch(DAEMON_INFO_URL, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30_000)
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
    };

    if (pageUrl && chrome.cookies) {
      chrome.cookies.getAll({ url: pageUrl }, (cookies) => {
        doFetch(cookies);
      });
    } else {
      doFetch(null);
    }

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

  // Handle request for completed lesson titles to skip already-downloaded lessons
  if (message.action === "GET_COMPLETED_TITLES") {
    fetch("http://localhost:8000/api/course/jobs")
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then(data => {
        const completed = (data.jobs || [])
          .filter(j => j.status === "completed")
          .map(j => (j.title || "").toLowerCase().trim());
        sendResponse({ ok: true, titles: completed });
      })
      .catch(err => {
        console.error(`${LOG} Failed to fetch completed jobs:`, err);
        sendResponse({ ok: false, error: err.message, titles: [] });
      });
    return true; // Keep message channel open for async response
  }

  if (message.action === "TRIGGER_DOWNLOAD") {
    const payload = message.payload;
    if (!payload || !payload.url) {
      sendResponse({ ok: false, error: "Missing payload or url" });
      return true;
    }

    const tabId = sender.tab?.id;

    const startDownload = (resolvedTitle) => {
      if (resolvedTitle) {
        payload.title = resolvedTitle;
      }

      // If triggered from main frame or no URL provided, use top-level tab URL.
      // If triggered from sub-frame, keep payload.url (the iframe/embed video URL).
      if (payload.format_id !== "raw-intercept" && sender.tab?.url) {
        const isMainFrame = sender.frameId === 0;
        if (isMainFrame || !payload.url) {
          payload.url = sender.tab.url;
        }
      }

      if (payload.format_id === "raw-intercept") {
        const buffer = tabBuffers.get(tabId);
        if (!buffer || !buffer.manifestUrl) {
          sendResponse({ ok: false, error: "Raw stream buffer expired" });
          return;
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

      // Fetch cookies and trigger download
      const pageUrl = sender.tab?.url;
      const userAgent = navigator.userAgent;

      const doDownload = async (cookieList) => {
        payload.user_agent = userAgent;
        if (cookieList && cookieList.length > 0) {
          payload.cookies = cookieList;
        }

        console.log(`${LOG} Triggering download from content script:`, payload);
        
        const authHeaders = await getAuthHeaders();
        fetch(DAEMON_URL, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(payload),
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
      };

      if (pageUrl && chrome.cookies) {
        chrome.cookies.getAll({ url: pageUrl }, (cookies) => {
          doDownload(cookies);
        });
      } else {
        doDownload(null);
      }
    };

    if (sender.frameId > 0 && tabId) {
      chrome.tabs.sendMessage(tabId, { action: "GET_MAIN_FRAME_TITLE" }, { frameId: 0 }, (res) => {
        // Clear runtime.lastError if main frame doesn't respond or script is not loaded
        const err = chrome.runtime.lastError;
        const cleanTitle = res?.title || sender.tab?.title || payload.title;
        startDownload(cleanTitle);
      });
    } else {
      startDownload(payload.title);
    }

    return true; // keep channel open for async response
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
  let cookieString = "";

  try {
    const cookies = await chrome.cookies.getAll({ url: url });
    cookieString = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  } catch (err) {
    console.warn(`${LOG} Failed to get cookies for ${url}:`, err);
  }

  // 4. Build payload
  const payload = {
    url: url,
    engine: "aria2"
  };

  if (referer) payload.referer = referer;
  if (userAgent) payload.user_agent = userAgent;
  if (cookieString) payload.cookies = cookieString;

  // 5. Dispatch to daemon
  try {
    const authHeaders = await getAuthHeaders();
    const response = await fetch(DAEMON_URL, {
      method: "POST",
      headers: authHeaders,
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
