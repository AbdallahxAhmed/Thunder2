/**
 * Bridge: Isolated world → Service Worker
 * Listens for MAIN world custom events and forwards via chrome.runtime.
 */
window.addEventListener("uhdd_payload_ready", (event) => {
  if (!event.detail || typeof event.detail !== "object") return;

  const { type, url, pssh, licenseUrl, licenseHeaders, drmKeys } = event.detail;

  chrome.runtime.sendMessage({
    type,
    url,
    pssh,
    licenseUrl,
    licenseHeaders,
    drmKeys,
  }).catch(() => {
    // Service worker may be waking up — ignore connection errors
  });
});
