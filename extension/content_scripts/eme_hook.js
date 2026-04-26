(function () {
  const LOG = "[UHDD]";

  // ─── State ────────────────────────────────────────────────────────────
  let capturedManifestUrl = null;
  let capturedPSSH = null;        // base64-encoded PSSH
  let capturedLicenseUrl = null;
  let capturedLicenseHeaders = {};

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

  function syncWithDaemon() {
    // For .mpd: require manifest + PSSH + license URL
    if (capturedManifestUrl && capturedPSSH && capturedLicenseUrl) {
      console.log(`${LOG} Full DRM package ready, dispatching...`);
      window.dispatchEvent(new CustomEvent("uhdd_payload_ready", {
        detail: {
          type: "drm_package",
          url: capturedManifestUrl,
          pssh: capturedPSSH,
          licenseUrl: capturedLicenseUrl,
          licenseHeaders: capturedLicenseHeaders,
        },
      }));
    }
  }

  // ─── Fetch Interception ───────────────────────────────────────────────

  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input && input.url ? input.url : "";

    // Capture .mpd / .m3u8 manifest URLs
    if (url.includes(".mpd") || url.includes(".m3u8")) {
      capturedManifestUrl = url;
      console.log(`${LOG} Manifest captured: ${url}`);

      // For .m3u8, dispatch immediately (no DRM expected)
      if (url.includes(".m3u8")) {
        window.dispatchEvent(new CustomEvent("uhdd_payload_ready", {
          detail: { type: "manifest", url: url },
        }));
      } else {
        syncWithDaemon();
      }
    }

    // Detect license server requests (binary body = CDM challenge)
    if (init && init.body) {
      let bodyBytes = init.body;
      if (bodyBytes instanceof Blob) {
        bodyBytes = await bodyBytes.arrayBuffer();
      }
      if (isLikelyChallenge(bodyBytes)) {
        capturedLicenseUrl = url;
        capturedLicenseHeaders = {};

        // Capture headers from the init object
        if (init.headers) {
          if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => {
              capturedLicenseHeaders[key] = value;
            });
          } else if (typeof init.headers === "object") {
            Object.assign(capturedLicenseHeaders, init.headers);
          }
        }

        console.log(`${LOG} License URL captured: ${url}`);
        syncWithDaemon();
      }
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
      console.log(`${LOG} Manifest captured (XHR): ${url}`);

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
    if (body && isLikelyChallenge(body)) {
      capturedLicenseUrl = this._uhddUrl;
      capturedLicenseHeaders = { ...this._uhddHeaders };
      console.log(`${LOG} License URL captured (XHR): ${this._uhddUrl}`);
      syncWithDaemon();
    }
    return originalXHRSend.apply(this, arguments);
  };

  // ─── EME Hooking (PSSH Extraction) ────────────────────────────────────

  const originalGenerateRequest = MediaKeySession.prototype.generateRequest;
  MediaKeySession.prototype.generateRequest = async function (initDataType, initData) {
    // Extract PSSH from initData
    const psshBase64 = arrayBufferToBase64(initData);
    capturedPSSH = psshBase64;
    console.log(`${LOG} PSSH captured (${initData.byteLength} bytes)`);
    syncWithDaemon();
    return originalGenerateRequest.apply(this, arguments);
  };

  console.log(`${LOG} License Proxy Hook v2 injected.`);
})();