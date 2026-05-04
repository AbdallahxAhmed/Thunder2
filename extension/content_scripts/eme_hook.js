(function () {
  const LOG = "[Thunder]";

  // ─── Known License Server Patterns ────────────────────────────────────
  // Add URL substrings or hostnames that identify Widevine license endpoints.
  // Detection fires on EITHER a URL match OR a binary CDM challenge signature.
  // Domain-specific DRM hints (e.g., Al Jazeera streams).
  const DOMAIN_DRM_PATTERNS = [
    "aljazeera",
  ];

  const TELEMETRY_DOMAINS = [
    "pndsn.com",
    "analytics",
    "telemetry",
    "tracking"
  ];

  const DRM_KEYWORDS = [
    "widevine",
    "drm",
    "license",
    "licence",
    "acquire",
    "key",
    "playready",
    "shield-drm.imggaming.com",
    ...DOMAIN_DRM_PATTERNS,
  ];

  // Headers we MUST capture from the license request (case-insensitive match)
  const PRIORITY_HEADERS = [
    "authorization",
    "x-drm-info",
    "realm",
    "content-type",
  ];

  // ─── State ────────────────────────────────────────────────────────────
  let capturedManifestUrl = null;
  let capturedPSSH = null;        // base64-encoded PSSH
  let capturedLicenseUrl = null;
  let capturedLicenseHeaders = {};
  let capturedDrmKeys = null;
  let drmDetected = false;
  let drmHintDispatched = false;
  let dispatched = false;

  // ─── Helpers ──────────────────────────────────────────────────────────

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function isLikelyChallenge(body) {
    // Widevine license challenges are binary (ArrayBuffer/Uint8Array)
    // and start with 0x08 0x04 (protobuf field 1, varint = 4 for LICENSE_REQUEST)
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      const arr = body instanceof Uint8Array ? body : new Uint8Array(body);
      return arr.length > 2 && arr[0] === 0x08 && arr[1] === 0x04;
    }
    return false;
  }

  function isLikelyChallenge(body) {
    // Widevine license challenges are binary (ArrayBuffer/Uint8Array)
    // and start with 0x08 0x04 (protobuf field 1, varint = 4 for LICENSE_REQUEST)
    if (body instanceof ArrayBuffer || body instanceof Uint8Array) {
      const arr = body instanceof Uint8Array ? body : new Uint8Array(body);
      return arr.length > 2 && arr[0] === 0x08 && arr[1] === 0x04;
    }
    return false;
  }

  function isLikelyDrmManifestUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return DRM_KEYWORDS.some((p) => lower.includes(p));
  }

  function sanitizeTitle(raw) {
    if (!raw || typeof raw !== "string") return null;

    const suffixes = [
      " - YouTube", " | Prime Video", " - Dailymotion",
      " - Watch Online", " - Crunchyroll", " - Netflix",
      " - Watch Free", " · GitHub"
    ];

    for (const suffix of suffixes) {
      if (raw.endsWith(suffix)) {
        raw = raw.substring(0, raw.length - suffix.length);
        break;
      }
    }

    let clean = raw.replace(/[/\\:*?"<>|]/g, "").trim();
    clean = clean.replace(/\s+/g, " ");
    if (clean.length > 200) clean = clean.substring(0, 200).trim();
    return clean || null;
  }

  function getPageTitle() {
    try { return sanitizeTitle(document.title); } catch (_) { return null; }
  }

  function extractHeaders(headersSource) {
    // Extracts ALL headers from a fetch init or XHR, ensuring priority headers
    // are always included when present.
    const result = {};
    if (!headersSource) return result;

    if (headersSource instanceof Headers) {
      headersSource.forEach((value, key) => {
        result[key] = value;
      });
    } else if (Array.isArray(headersSource)) {
      headersSource.forEach(([key, value]) => {
        result[key] = value;
      });
    } else if (typeof headersSource === "object") {
      Object.entries(headersSource).forEach(([key, value]) => {
        result[key] = String(value);
      });
    }
    return result;
  }

  function resolveFetchUrl(input) {
    if (typeof input === "string") return input;
    if (input instanceof Request) return input.url || "";
    if (input instanceof URL) return input.toString();
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function syncWithDaemon() {
    const hasFullWidevine = capturedPSSH && capturedLicenseUrl;
    if (capturedManifestUrl && (hasFullWidevine || capturedDrmKeys) && !dispatched) {
      dispatched = true;

      const headerCount = Object.keys(capturedLicenseHeaders).length;
      const priorityCaptured = PRIORITY_HEADERS.filter(
        (h) => Object.keys(capturedLicenseHeaders).some((k) => k.toLowerCase() === h)
      );

      const title = getPageTitle();

      console.log(`${LOG} ✅ Full DRM package ready!`);
      console.log(`${LOG}   Title:   ${title}`);
      console.log(`${LOG}   MPD:     ${capturedManifestUrl}`);
      if (capturedDrmKeys) {
        console.log(`${LOG}   Keys:    ${capturedDrmKeys}`);
      } else {
        console.log(`${LOG}   PSSH:    ${capturedPSSH.substring(0, 40)}…`);
        console.log(`${LOG}   License: ${capturedLicenseUrl}`);
        console.log(`${LOG}   Headers: ${headerCount} total, priority [${priorityCaptured.join(", ")}]`);
      }

      window.dispatchEvent(new CustomEvent("thunder_payload_ready", {
        detail: {
          type: "drm_package",
          url: capturedManifestUrl,
          pssh: capturedPSSH,
          licenseUrl: capturedLicenseUrl,
          licenseHeaders: capturedLicenseHeaders,
          drmKeys: capturedDrmKeys,
          title: title,
          drmHint: true,
        },
      }));
    }
  }

  function dispatchDrmHintIfNeeded() {
    if (!capturedManifestUrl || dispatched || drmHintDispatched) return;
    drmHintDispatched = true;
    window.dispatchEvent(new CustomEvent("thunder_payload_ready", {
      detail: {
        type: "manifest",
        url: capturedManifestUrl,
        title: getPageTitle(),
        drmHint: true,
      },
    }));
  }

  // ─── License Request Detection (shared logic) ─────────────────────────

  function handlePotentialLicenseRequest(url, headers, body, method) {
    if (method !== "POST" && method !== "PUT") return false;

    // Strict Binary Payload Check:
    // Ignore telemetry requests that send JSON/Strings.
    if (!body || !(body instanceof ArrayBuffer || body instanceof Uint8Array || body instanceof DataView)) {
      return false;
    }

    const lowerUrl = url ? url.toLowerCase() : "";
    if (TELEMETRY_DOMAINS.some(d => lowerUrl.includes(d))) return false;

    const urlMatch = DRM_KEYWORDS.some(k => lowerUrl.includes(k));
    const headerMatch = headers && DRM_KEYWORDS.some(k => JSON.stringify(headers).toLowerCase().includes(k));
    const bodyMatch = body && isLikelyChallenge(body);

    if (urlMatch || headerMatch || bodyMatch) {
      capturedLicenseUrl = url;
      capturedLicenseHeaders = extractHeaders(headers);

      // --- AGGRESSIVE BODY LOGGING (REDACTED FOR PROD) ---
      let bodyType = typeof body;
      
      if (body instanceof ArrayBuffer || body instanceof Uint8Array || body instanceof DataView) {
        const len = body.byteLength || body.length;
        bodyType = `ArrayBuffer/Uint8Array (${len} bytes)`;
      }

      console.log(`${LOG} 🐛 License Body Type: ${bodyType}`);
      // ------------------------------------

      if (body) {
        try {
          const bodyStr = typeof body === "string" ? body : new TextDecoder().decode(body);
          if (bodyStr.trim().startsWith("{")) {
            capturedLicenseHeaders["x-thunder-original-body"] = bodyStr;
          }
        } catch (e) {}
      }

      drmDetected = true;
      dispatchDrmHintIfNeeded();

      const reason = (urlMatch || headerMatch) && bodyMatch ? "Keywords + challenge"
                   : (urlMatch || headerMatch) ? "Keywords pattern"
                   : "CDM challenge bytes";

      console.log(`${LOG} 🔑 License URL captured (${reason}): ${url}`);
      console.log(`${LOG}    Headers: ${JSON.stringify(capturedLicenseHeaders, null, 2)}`);

      syncWithDaemon();
      return true;
    }
    return false;
  }

  // ─── Fetch Interception ───────────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const request = input instanceof Request ? input : null;
    const url = resolveFetchUrl(input);

    // Capture .mpd / .m3u8 manifest URLs
    if (url.includes(".mpd") || url.includes(".m3u8")) {
      capturedManifestUrl = url;
      console.log(`${LOG} 📡 Manifest captured: ${url}`);

      if (url.includes(".m3u8")) {
        const drmHint = drmDetected || isLikelyDrmManifestUrl(url);
        window.dispatchEvent(new CustomEvent("thunder_payload_ready", {
          detail: {
            type: "manifest",
            url: url,
            title: getPageTitle(),
            drmHint,
          },
        }));
      } else {
        syncWithDaemon();
      }
    }

    // Detect license server requests
    let bodyBytes = null;
    let mergedHeaders = null;

    if (init && init.body) {
      bodyBytes = init.body;
      if (bodyBytes instanceof Blob) {
        try { bodyBytes = await bodyBytes.arrayBuffer(); } catch (_) {}
      }
    } else if (request) {
      const requestMethod = request.method;
      if (requestMethod !== "GET" && requestMethod !== "HEAD") {
        try {
          bodyBytes = await request.clone().arrayBuffer();
        } catch (_) {}
      }
    }

    const headerSources = [request?.headers, init?.headers].filter(Boolean);
    if (headerSources.length) {
      const combined = headerSources.reduce(
        (acc, src) => Object.assign(acc, extractHeaders(src)),
        {},
      );
      if (Object.keys(combined).length > 0) {
        mergedHeaders = combined;
      }
    }

    const reqMethod = (request ? request.method : init?.method) || "GET";
    const method = reqMethod.toUpperCase();

    const hasHeaders = Boolean(mergedHeaders);
    if (bodyBytes || hasHeaders || DRM_KEYWORDS.some(k => url.toLowerCase().includes(k))) {
      handlePotentialLicenseRequest(url, mergedHeaders, bodyBytes, method);
    }

    return originalFetch.apply(this, arguments);
  };

  // ─── XHR Interception ─────────────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._thunderMethod = typeof method === "string" ? method.toUpperCase() : "GET";
    this._thunderUrl = url;
    this._thunderHeaders = {};

    // Capture .mpd / .m3u8
    if (typeof url === "string" && (url.includes(".mpd") || url.includes(".m3u8"))) {
      capturedManifestUrl = url;
      console.log(`${LOG} 📡 Manifest captured (XHR): ${url}`);

      if (url.includes(".m3u8")) {
        const drmHint = drmDetected || isLikelyDrmManifestUrl(url);
        window.dispatchEvent(new CustomEvent("thunder_payload_ready", {
          detail: { type: "manifest", url: url, drmHint },
        }));
      } else {
        syncWithDaemon();
      }
    }

    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._thunderHeaders) {
      this._thunderHeaders[name] = value;
    }
    return originalXHRSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    handlePotentialLicenseRequest(this._thunderUrl, this._thunderHeaders, body, this._thunderMethod);
    return originalXHRSend.apply(this, arguments);
  };

  // ─── EME Hooking (Key Ripping & PSSH) ─────────────────────────────────

  function base64UrlToHex(base64Url) {
    const padding = '='.repeat((4 - base64Url.length % 4) % 4);
    const base64 = (base64Url + padding).replace(/\-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    let hex = '';
    for (let i = 0; i < rawData.length; ++i) {
      const hexChar = rawData.charCodeAt(i).toString(16);
      hex += (hexChar.length === 1 ? '0' : '') + hexChar;
    }
    return hex;
  }

  const originalUpdate = MediaKeySession.prototype.update;
  MediaKeySession.prototype.update = async function (response) {
    // Attempt 1: ClearKey JSON format {keys: [{kid, k}]}
    try {
      const str = new TextDecoder().decode(response);
      const json = JSON.parse(str);
      if (json.keys) {
        const keysList = [];
        for (const k of json.keys) {
          if (k.kid && k.k) {
            keysList.push(`${base64UrlToHex(k.kid)}:${base64UrlToHex(k.k)}`);
          }
        }
        if (keysList.length > 0) {
          capturedDrmKeys = keysList.join(',');
          drmDetected = true;
          console.log(`${LOG} 🗝️ RIPPED KEYS (ClearKey): ${capturedDrmKeys}`);
          syncWithDaemon();
        }
      }
    } catch (e) {
      console.log(`${LOG} 🔍 License response is NOT JSON (likely Widevine binary protobuf)`);
    }

    // After the real update, listen for key status changes to extract KIDs
    const session = this;
    const result = originalUpdate.apply(this, arguments);

    // Use keystatuseschange to confirm keys were loaded
    try {
      result.then(() => {
        if (session.keyStatuses && session.keyStatuses.size > 0) {
          const kids = [];
          session.keyStatuses.forEach((status, keyId) => {
            const kidHex = Array.from(new Uint8Array(keyId)).map(b => b.toString(16).padStart(2, '0')).join('');
            console.log(`${LOG} 🔑 Key Status: KID=${kidHex} status=${status}`);
            kids.push(kidHex);
          });
          console.log(`${LOG} 🔑 ${kids.length} key(s) loaded in session. KIDs: ${kids.join(', ')}`);
        }
      }).catch(() => {});
    } catch (e) {}

    return result;
  };

  const originalGenerateRequest = MediaKeySession.prototype.generateRequest;
  MediaKeySession.prototype.generateRequest = async function (initDataType, initData) {
    const psshBase64 = arrayBufferToBase64(initData);
    capturedPSSH = psshBase64;
    drmDetected = true;
    dispatchDrmHintIfNeeded();
    console.log(`${LOG} 🛡️ PSSH captured (${initData.byteLength} bytes, type: ${initDataType})`);
    syncWithDaemon();
    return originalGenerateRequest.apply(this, arguments);
  };

  console.log(`${LOG} License Proxy Hook v3 — targeting: ${DRM_KEYWORDS.join(", ")}`);
})();
