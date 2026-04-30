(function () {
  const LOG = "[UHDD]";

  // ─── Known License Server Patterns ────────────────────────────────────
  // Add URL substrings or hostnames that identify Widevine license endpoints.
  // Detection fires on EITHER a URL match OR a binary CDM challenge signature.
  const LICENSE_URL_PATTERNS = [
    "shield-drm.imggaming.com",
    "/api/v2/license",
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

  function isKnownLicenseUrl(url) {
    if (!url) return false;
    const lower = url.toLowerCase();
    return LICENSE_URL_PATTERNS.some((p) => lower.includes(p));
  }

  function sanitizeTitle(raw) {
    if (!raw || typeof raw !== "string") return null;
    // Strip invalid filename chars: / \ : * ? " < > |
    let clean = raw.replace(/[/\\:*?"<>|]/g, "").trim();
    // Collapse multiple spaces/underscores
    clean = clean.replace(/\s+/g, " ");
    // Truncate to 200 chars to stay filesystem-safe
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
    // Require manifest + PSSH + license URL — dispatch once
    if (capturedManifestUrl && capturedPSSH && capturedLicenseUrl && !dispatched) {
      dispatched = true;

      const headerCount = Object.keys(capturedLicenseHeaders).length;
      const priorityCaptured = PRIORITY_HEADERS.filter(
        (h) => Object.keys(capturedLicenseHeaders).some((k) => k.toLowerCase() === h)
      );

      const title = getPageTitle();

      console.log(`${LOG} ✅ Full DRM package ready!`);
      console.log(`${LOG}   Title:   ${title}`);
      console.log(`${LOG}   MPD:     ${capturedManifestUrl}`);
      console.log(`${LOG}   PSSH:    ${capturedPSSH.substring(0, 40)}…`);
      console.log(`${LOG}   License: ${capturedLicenseUrl}`);
      console.log(`${LOG}   Headers: ${headerCount} total, priority [${priorityCaptured.join(", ")}]`);

      window.dispatchEvent(new CustomEvent("uhdd_payload_ready", {
        detail: {
          type: "drm_package",
          url: capturedManifestUrl,
          pssh: capturedPSSH,
          licenseUrl: capturedLicenseUrl,
          licenseHeaders: capturedLicenseHeaders,
          title: title,
        },
      }));
    }
  }

  // ─── License Request Detection (shared logic) ─────────────────────────

  function handlePotentialLicenseRequest(url, headers, body) {
    // Two-pronged detection:
    //   1) URL matches a known license server pattern
    //   2) Body looks like a binary Widevine CDM challenge
    // Either condition is sufficient to capture the license URL.
    const urlMatch = isKnownLicenseUrl(url);
    const bodyMatch = body && isLikelyChallenge(body);

    if (urlMatch || bodyMatch) {
      capturedLicenseUrl = url;
      capturedLicenseHeaders = extractHeaders(headers);

      const reason = urlMatch && bodyMatch ? "URL + challenge"
                   : urlMatch             ? "URL pattern"
                   :                        "CDM challenge bytes";

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
        window.dispatchEvent(new CustomEvent("uhdd_payload_ready", {
          detail: { type: "manifest", url: url, title: getPageTitle() },
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
    } else if (request && request.method?.toUpperCase() !== "GET") {
      try {
        bodyBytes = await request.clone().arrayBuffer();
      } catch (_) {}
    }

    const headerSources = [];
    if (request?.headers) headerSources.push(request.headers);
    if (init?.headers) headerSources.push(init.headers);
    if (headerSources.length) {
      const combined = Object.assign(
        {},
        ...headerSources.map((src) => extractHeaders(src)),
      );
      if (Object.keys(combined).length > 0) {
        mergedHeaders = combined;
      }
    }

    if (bodyBytes || mergedHeaders || isKnownLicenseUrl(url)) {
      handlePotentialLicenseRequest(url, mergedHeaders, bodyBytes);
    }

    return originalFetch.apply(this, arguments);
  };

  // ─── XHR Interception ─────────────────────────────────────────────────

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this._uhddUrl = url;
    this._uhddHeaders = {};

    // Capture .mpd / .m3u8
    if (typeof url === "string" && (url.includes(".mpd") || url.includes(".m3u8"))) {
      capturedManifestUrl = url;
      console.log(`${LOG} 📡 Manifest captured (XHR): ${url}`);

      if (url.includes(".m3u8")) {
        window.dispatchEvent(new CustomEvent("uhdd_payload_ready", {
          detail: { type: "manifest", url: url },
        }));
      } else {
        syncWithDaemon();
      }
    }

    return originalXHROpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._uhddHeaders) {
      this._uhddHeaders[name] = value;
    }
    return originalXHRSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    handlePotentialLicenseRequest(this._uhddUrl, this._uhddHeaders, body);
    return originalXHRSend.apply(this, arguments);
  };

  // ─── EME Hooking (PSSH Extraction) ────────────────────────────────────

  const originalGenerateRequest = MediaKeySession.prototype.generateRequest;
  MediaKeySession.prototype.generateRequest = async function (initDataType, initData) {
    const psshBase64 = arrayBufferToBase64(initData);
    capturedPSSH = psshBase64;
    console.log(`${LOG} 🛡️ PSSH captured (${initData.byteLength} bytes, type: ${initDataType})`);
    syncWithDaemon();
    return originalGenerateRequest.apply(this, arguments);
  };

  console.log(`${LOG} License Proxy Hook v3 — targeting: ${LICENSE_URL_PATTERNS.join(", ")}`);
})();
