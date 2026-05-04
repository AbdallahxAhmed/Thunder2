/**
 * Bridge: Isolated world → Service Worker
 * Listens for MAIN world custom events and forwards via chrome.runtime.
 */
window.addEventListener("thunder_payload_ready", (event) => {
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
