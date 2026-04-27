/**
 * UHDD Service Worker — Background Script
 * Manages per-tab interception buffers, dispatches to daemon, shows notifications.
 * Implements zero-latency pre-fetching of format info for supported media sites.
 */

const DAEMON_URL = "http://localhost:8000/api/download";
const DAEMON_INFO_URL = "http://localhost:8000/api/info";
const LOG = "[UHDD SW]";

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
      dispatchedUrls: new Set(),
    });
  }
  return tabBuffers.get(tabId);
}

// ─── Format Info Cache ────────────────────────────────────────────────
// Keyed by tabId → { url, data, ts, status }
// status: "ready" | "fetching" | "error"

const formatCache = new Map();

// Domains eligible for pre-fetching (mirrors router.py KNOWN_MEDIA_DOMAINS)
const PREFETCH_DOMAINS = new Set([
  "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com",
  "music.youtube.com", "twitter.com", "www.twitter.com",
  "x.com", "www.x.com", "vimeo.com", "www.vimeo.com",
  "dailymotion.com", "www.dailymotion.com", "twitch.tv",
  "www.twitch.tv", "clips.twitch.tv", "tiktok.com",
  "www.tiktok.com", "instagram.com", "www.instagram.com",
  "soundcloud.com", "www.soundcloud.com", "reddit.com",
  "www.reddit.com", "v.redd.it", "facebook.com",
  "www.facebook.com", "fb.watch",
]);

/**
 * Fetch format info from the daemon and populate the cache.
 * Returns the cached entry or null on failure.
 */
async function prefetchFormats(tabId, url) {
  // Don't re-fetch if we already have a fresh entry for this URL
  const existing = formatCache.get(tabId);
  if (existing && existing.url === url && existing.status === "fetching") {
    return; // another fetch is already in flight
  }
  if (existing && existing.url === url && existing.status === "ready" &&
      (Date.now() - existing.ts) < 300_000) {
    return; // still fresh
  }

  // Mark as fetching so concurrent opens don't duplicate
  formatCache.set(tabId, { url, data: null, ts: 0, status: "fetching" });
  console.log(`${LOG} Pre-fetching formats for tab ${tabId}: ${url.substring(0, 60)}…`);

  try {
    const resp = await fetch(
      `${DAEMON_INFO_URL}?url=${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(30_000) }
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    formatCache.set(tabId, { url, data, ts: Date.now(), status: "ready" });
    console.log(`${LOG} Pre-fetch complete for tab ${tabId} — ${data.options?.length || 0} options`);
  } catch (err) {
    console.warn(`${LOG} Pre-fetch failed for tab ${tabId}:`, err.message);
    formatCache.set(tabId, { url, data: null, ts: Date.now(), status: "error" });
  }
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

// ─── Tab Lifecycle ────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => {
  tabBuffers.delete(tabId);
  formatCache.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // ── SPA URL change detection (e.g. YouTube client-side navigation) ──
  // changeInfo.url fires when the tab's URL changes, even without a
  // full page load.  Invalidate that specific tab's cache and re-fetch.
  if (changeInfo.url && tab.url) {
    const cached = formatCache.get(tabId);
    if (cached && cached.url !== tab.url) {
      console.log(`${LOG} URL changed for tab ${tabId}, invalidating cache`);
      formatCache.delete(tabId);
    }
    // Immediately try to pre-fetch for the new URL
    // try {
    //   const hostname = new URL(tab.url).hostname;
    //   if (PREFETCH_DOMAINS.has(hostname)) {
    //     prefetchFormats(tabId, tab.url);
    //   }
    // } catch (_) { /* invalid URL */ }
    return;
  }

  if (changeInfo.status === "loading") {
    // Full navigation started — invalidate stale cache
    tabBuffers.delete(tabId);
    formatCache.delete(tabId);
  }

  // ── Pre-fetch trigger (page finished loading) ──────────────────────
  // if (changeInfo.status === "complete" && tab.url) {
  //   try {
  //     const hostname = new URL(tab.url).hostname;
  //     if (PREFETCH_DOMAINS.has(hostname)) {
  //       prefetchFormats(tabId, tab.url);
  //     }
  //   } catch (_) { /* invalid URL */ }
  // }
});

// ── Pre-fetch on tab activation (switching between tabs) ─────────────
// Ensures data is warm even when the user switches back to a media tab
// that was loaded a while ago and whose cache may have expired.
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  // const tabId = activeInfo.tabId;
  // try {
  //   const tab = await chrome.tabs.get(tabId);
  //   if (!tab.url) return;
  //   const hostname = new URL(tab.url).hostname;
  //   if (PREFETCH_DOMAINS.has(hostname)) {
  //     prefetchFormats(tabId, tab.url);
  //   }
  // } catch (_) { /* tab may have been closed */ }
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
      if (message.title) buffer.title = message.title;
      // NOTE: NO dispatchToUHDD() — user must explicitly trigger download
      return;
    } else if (message.type === "drm_package") {
      console.log(`${LOG} [tab ${tabId}] DRM package cached (no auto-dispatch)`);
      buffer.manifestUrl = message.url;
      buffer.pssh = message.pssh;
      buffer.licenseUrl = message.licenseUrl;
      buffer.licenseHeaders = message.licenseHeaders || {};
      if (message.title) buffer.title = message.title;
      // NOTE: NO dispatchToUHDD() — user must explicitly trigger download
      return;
    }
  }

  // Handle messages from the popup or content script
  if (message.type === "getFormats" || message.action === "GET_HYBRID_STREAMS") {
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
    if (cached && cached.url === url && cached.status === "ready" &&
        (Date.now() - cached.ts) < 300_000) {
      console.log(`${LOG} Format cache HIT for tab ${tabId}`);
      sendHybridResponse(cached.data, true);
      return true;
    }

    // ── Cache is currently fetching — poll at 100ms for fast resolution ─
    if (cached && cached.url === url && cached.status === "fetching") {
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
    console.log(`${LOG} Format cache MISS for tab ${tabId}, fetching…`);
    formatCache.set(tabId, { url, data: null, ts: 0, status: "fetching" });
    fetch(`${DAEMON_INFO_URL}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(30_000) })
      .then(resp => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      })
      .then(data => {
        formatCache.set(tabId, { url, data, ts: Date.now(), status: "ready" });
        sendHybridResponse(data, false);
      })
      .catch(err => {
        console.error(`${LOG} /api/info failed:`, err);
        formatCache.set(tabId, { url, data: null, ts: Date.now(), status: "error" });
        if (hasRawStream) sendHybridResponse(null, false);
        else sendResponse({ ok: false, error: err.message });
      });

    return true; // keep channel open for async response
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
      payload.url = buffer.manifestUrl;
      delete payload.format_id;
      
      if (buffer.pssh && buffer.licenseUrl) {
        payload.pssh = buffer.pssh;
        payload.license_url = buffer.licenseUrl;
        payload.license_headers = buffer.licenseHeaders || {};
      }
      if (buffer.title) payload.title = buffer.title;
    }

    console.log(`${LOG} Triggering download from content script:`, payload);
    
    fetch(DAEMON_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
        title: "UHDD: Download Queued",
        message: `${payload.url.substring(0, 50)}… → ${engine}`,
      });
      sendResponse({ ok: true, data });
    })
    .catch(err => {
      console.error(`${LOG} Download trigger failed:`, err);
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "UHDD: Backend Offline",
        message: "Could not reach UHDD daemon at localhost:8000",
      });
      sendResponse({ ok: false, error: err.message });
    });

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
        title: "UHDD: Download Hijacked",
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
      title: "UHDD: Backend Offline",
      message: "Could not reach UHDD daemon. Download proceeding natively.",
    });
    // We don't cancel the download, so it falls back to Chrome gracefully
  }
});
