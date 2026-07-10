// Invalidate background tab buffer immediately at document_start
if (window === window.top) {
  chrome.runtime.sendMessage({ action: "CLEAR_BUFFER" }).catch(() => {});
}

window.addEventListener("uhdd_payload_ready", (event) => {
  if (!event.detail || typeof event.detail !== "object") return;

  const { type, url, pssh, licenseUrl, licenseHeaders, drmKeys, title, drmHint } = event.detail;

  chrome.runtime.sendMessage({
    type,
    url,
    pssh,
    licenseUrl,
    licenseHeaders,
    drmKeys,
    title,
    drmHint,
  }).catch(() => {
    // Service worker may be waking up — ignore connection errors
  });
});
