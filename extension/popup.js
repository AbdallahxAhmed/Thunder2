/**
 * UHDD Popup — Quality Picker (Zero-Latency Architecture)
 *
 * Communicates with the service worker (background.js) which pre-fetches
 * format data when a supported tab loads.  If data is already cached,
 * the popup renders instantly — no spinner.
 */

const DAEMON_URL = "http://localhost:8000";

const KNOWN_MEDIA_DOMAINS = new Set([
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

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      showError("Unable to get current tab URL.");
      return;
    }

    let urlObj;
    try {
      urlObj = new URL(tab.url);
    } catch (e) {
      showError("Invalid URL format.");
      return;
    }

    if (!KNOWN_MEDIA_DOMAINS.has(urlObj.hostname)) {
      showError("No downloadable media detected on this page.");
      return;
    }

    // Ask background.js — it may already have pre-fetched the data
    chrome.runtime.sendMessage(
      { type: "getFormats", tabId: tab.id, url: tab.url },
      (response) => {
        if (chrome.runtime.lastError) {
          showError("Backend offline \u2014 start the UHDD daemon.");
          return;
        }
        if (!response || !response.ok) {
          const msg = response?.error?.includes("422")
            ? "Unsupported URL or no formats available."
            : "Backend offline \u2014 start the UHDD daemon.";
          showError(msg);
          return;
        }
        renderOptions(response.data, tab.url, response.fromCache);
      }
    );
  } catch (error) {
    showError("Backend offline \u2014 start the UHDD daemon.");
    console.error(error);
  }
});

// ─── Render quality options ──────────────────────────────────────────

function renderOptions(data, url, fromCache) {
  const container = document.getElementById("quality-options");
  const titleEl = document.getElementById("media-title");

  container.innerHTML = "";

  if (!data.options || data.options.length === 0) {
    showError("No formats available for this media.");
    return;
  }

  // Show media title if available
  if (data.title) {
    titleEl.textContent = data.title;
    titleEl.style.display = "block";
  }

  data.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = `format-btn ${opt.type === "audio" ? "audio" : "video"}`;
    // Highlight the first option (Best Quality)
    if (idx === 0) btn.classList.add("recommended");

    // Icon badge (left side)
    const iconSpan = document.createElement("span");
    iconSpan.className = "quality-icon";
    if (opt.type === "audio") {
      iconSpan.textContent = "♫";
    } else if (opt.badge === "4K") {
      iconSpan.textContent = "4K";
    } else if (opt.badge === "QHD") {
      iconSpan.textContent = "2K";
    } else if (opt.badge === "HD" || opt.badge === "HQ") {
      iconSpan.textContent = "HD";
    } else {
      iconSpan.textContent = "▶";
    }

    // Label + optional quality badge
    const labelWrap = document.createElement("div");
    labelWrap.className = "quality-label-wrap";

    const labelSpan = document.createElement("span");
    labelSpan.className = "quality-label";
    labelSpan.textContent = opt.label;

    labelWrap.appendChild(labelSpan);

    // HQ/HD/4K badge pill (right of label)
    if (opt.badge) {
      const badgePill = document.createElement("span");
      badgePill.className = `quality-badge badge-${opt.badge.toLowerCase()}`;
      badgePill.textContent = opt.badge;
      labelWrap.appendChild(badgePill);
    }

    // Download arrow
    const arrow = document.createElement("span");
    arrow.className = "quality-arrow";
    arrow.textContent = "↓";

    btn.appendChild(iconSpan);
    btn.appendChild(labelWrap);
    btn.appendChild(arrow);

    btn.addEventListener("click", () => dispatchDownload(url, opt.format_id, btn));

    container.appendChild(btn);
  });

  showState("loaded-state");
}

// ─── Dispatch download ───────────────────────────────────────────────

async function dispatchDownload(url, format_id, btn) {
  // Visual feedback — disable all buttons, highlight selected
  const allBtns = document.querySelectorAll(".format-btn");
  allBtns.forEach((b) => (b.disabled = true));
  btn.classList.add("dispatching");

  try {
    const response = await fetch(`${DAEMON_URL}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, engine: "ytdlp", format_id }),
    });

    if (response.ok) {
      showState("success-state");
    } else {
      showError("Failed to queue download.");
    }
  } catch (err) {
    showError("Backend offline \u2014 start the UHDD daemon.");
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function showState(stateId) {
  const states = ["loading-state", "error-state", "loaded-state", "success-state"];
  states.forEach((id) => {
    document.getElementById(id).classList.toggle("hidden", id !== stateId);
  });
}

function showError(message) {
  document.getElementById("error-message").textContent = message;
  showState("error-state");
}
