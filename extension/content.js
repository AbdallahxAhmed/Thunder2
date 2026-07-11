const LOG = "[Thunder UI]";
const STATE_PILL = "STATE_PILL";
const STATE_MENU = "STATE_MENU";

let uiHost = null;
let shadowRoot = null;
let uiContainer = null;
let observer = null;

// Map<HTMLVideoElement, PillInstance>
const pillRegistry = new Map();

// Observers
let resizeObserver = null;
let intersectionObserver = null;

// RAF tracking
let isUpdateScheduled = false;

// Global Activity Tracker
let activityTimeout = null;
let isUIActive = false;
let preWarmSent = false;
let preWarmUrl = "";

const HOST_STYLE = `
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
  background: transparent !important;
`;

function init() {
  injectHost();
  setupGlobalTracking();
  setupGlobalInteractions();
  setupVideoDetection();
}

function injectHost() {
  if (uiHost) return;

  uiHost = document.createElement("div");
  uiHost.id = "uhdd-host";
  uiHost.style.cssText = HOST_STYLE;

  shadowRoot = uiHost.attachShadow({ mode: "closed" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("content.css");
  shadowRoot.appendChild(link);

  uiContainer = document.createElement("div");
  uiContainer.id = "uhdd-container";
  shadowRoot.appendChild(uiContainer);

  (document.body || document.documentElement).appendChild(uiHost);
  console.log(`${LOG} Host injected successfully.`);
}

// Activity-Based Visibility Fix: Any mouse movement triggers the UI
function triggerActivity(duration = 2000) {
  if (!isUIActive) {
    isUIActive = true;
    updateAllPillsVisibility();

    // Predictive Pre-warming
    if (!preWarmSent || preWarmUrl !== window.location.href) {
      preWarmUrl = window.location.href;
      preWarmSent = true;
      try {
        chrome.runtime.sendMessage({ action: "PRE_WARM_URL", url: preWarmUrl });
      } catch (e) {}
    }
  }
  if (activityTimeout) clearTimeout(activityTimeout);
  activityTimeout = setTimeout(() => {
    isUIActive = false;
    updateAllPillsVisibility();
  }, duration);
}

function setupGlobalTracking() {
  // Resize observer to detect fullscreen transitions or fluid layout changes
  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      if (entry.target.tagName === "VIDEO") {
        if (pillRegistry.has(entry.target)) {
          schedulePositionUpdate();
        }
      }
    }
  });

  // Intersection observer to hide pills when video is out of viewport
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const instance = pillRegistry.get(entry.target);
        if (instance) {
          instance.isVisible = entry.isIntersecting;
          updateAllPillsVisibility();
          if (entry.isIntersecting) {
            schedulePositionUpdate();
          }
        }
      }
    },
    { threshold: 0 },
  );

  window.addEventListener("scroll", schedulePositionUpdate, {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", schedulePositionUpdate, { passive: true });

  document.addEventListener("mousemove", () => triggerActivity(2000), {
    passive: true,
    capture: true,
  });
  document.addEventListener("mousedown", () => triggerActivity(2000), {
    passive: true,
    capture: true,
  });
  document.addEventListener("keydown", () => triggerActivity(2000), {
    passive: true,
    capture: true,
  });
  document.addEventListener("scroll", () => triggerActivity(2000), {
    passive: true,
    capture: true,
  });

  // Trigger initial activity to show the pill for 6 seconds on load
  triggerActivity(6000);
}

// ─── SPA Navigation: re-scan for <video> when tab becomes visible again ──
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    console.log(`${LOG} Tab became visible, re-scanning for videos`);
    document.querySelectorAll("video").forEach(processVideoElement);
    schedulePositionUpdate();
  }
});

// ─── Drag Position Persistence ───────────────────────────────────────────
function getDragStorageKey() {
  try { return `thunder_drag_${location.hostname}`; } catch { return null; }
}

function saveDragOffset(offset) {
  const key = getDragStorageKey();
  if (key) {
    try { sessionStorage.setItem(key, JSON.stringify(offset)); } catch {}
  }
}

function loadDragOffset() {
  const key = getDragStorageKey();
  if (key) {
    try {
      const saved = sessionStorage.getItem(key);
      if (saved) return JSON.parse(saved);
    } catch {}
  }
  return { x: 0, y: 0 };
}

function updateAllPillsVisibility() {
  for (const instance of pillRegistry.values()) {
    if (!instance.isVisible) {
      instance.element.classList.remove("active");
      continue;
    }

    // Always visible if menu is open, hovered, or parent video is hovered
    if (instance.state === STATE_MENU || instance.isHovered || instance.isVideoHovered) {
      instance.element.classList.add("active");
      continue;
    }

    // Fade in on activity, fade back to faint ghost on idle
    if (isUIActive) {
      instance.element.classList.add("active");
    } else {
      instance.element.classList.remove("active");
    }
  }
}

function schedulePositionUpdate() {
  if (!isUpdateScheduled) {
    isUpdateScheduled = true;
    requestAnimationFrame(() => {
      updateAllPillPositions();
      isUpdateScheduled = false;
    });
  }
}

function updateAllPillPositions() {
  for (const instance of pillRegistry.values()) {
    if (!instance.isVisible) continue;
    updatePillPosition(instance);
  }
}

function updatePillPosition(instance) {
  const rect = instance.video.getBoundingClientRect();

  // Re-check size in case it became too small
  if (rect.width < 100 || rect.height < 100) {
    instance.element.style.display = "none";
    return;
  }
  instance.element.style.display = "flex";

  // Phase 5: Size-Adaptive Logic
  const isMini = rect.width <= 400;
  if (isMini) {
    instance.element.classList.add("mini");
  } else {
    instance.element.classList.remove("mini");
  }

  const padding = 16;
  const elWidth = isMini ? 32 : 110;
  const elHeight = 32;

  // Base anchor is top-right corner of the video
  let baseLeft = rect.right - elWidth - padding;
  let baseTop = rect.top + padding;

  // Apply drag offset
  let posLeft = baseLeft + instance.dragOffset.x;
  let posTop = baseTop + instance.dragOffset.y;

  // Clamp strictly to video boundaries
  const maxLeft = rect.right - elWidth;
  const minLeft = rect.left;
  const maxTop = rect.bottom - elHeight;
  const minTop = rect.top;

  posLeft = Math.max(minLeft, Math.min(posLeft, maxLeft));
  posTop = Math.max(minTop, Math.min(posTop, maxTop));

  // Re-sync dragOffset in case clamping triggered
  instance.dragOffset.x = posLeft - baseLeft;
  instance.dragOffset.y = posTop - baseTop;

  // If in menu state, respect the absolute corner anchoring to allow CSS morphing
  if (instance.state === STATE_MENU) {
    if (instance.anchorRight) {
      const rightPx = window.innerWidth - (posLeft + elWidth);
      instance.element.style.right = `${rightPx}px`;
      instance.element.style.left = "auto";
    } else {
      instance.element.style.left = `${posLeft}px`;
      instance.element.style.right = "auto";
    }

    if (instance.anchorBottom) {
      const bottomPx = window.innerHeight - (posTop + elHeight);
      instance.element.style.bottom = `${bottomPx}px`;
      instance.element.style.top = "auto";
    } else {
      instance.element.style.top = `${posTop}px`;
      instance.element.style.bottom = "auto";
    }
  } else {
    instance.element.style.left = `${posLeft}px`;
    instance.element.style.top = `${posTop}px`;
    instance.element.style.right = "auto";
    instance.element.style.bottom = "auto";
  }
}

function setupVideoDetection() {
  document.querySelectorAll("video").forEach(processVideoElement);
  document.querySelectorAll("iframe").forEach(enrichIframe);

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "VIDEO") {
            processVideoElement(node);
          } else if (node.tagName === "IFRAME") {
            enrichIframe(node);
          } else {
            node.querySelectorAll("video").forEach(processVideoElement);
            node.querySelectorAll("iframe").forEach(enrichIframe);
          }
        }
      }
      for (const node of mutation.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "VIDEO") {
            destroyPill(node);
          } else {
            node.querySelectorAll("video").forEach(destroyPill);
          }
        }
      }
    }
  });

  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
}

function enrichIframe(iframe) {
  try {
    const src = iframe.src || "";
    // Only target potential media embeds to avoid reloading unrelated frames
    const isMediaHost = [
      "mediadelivery.net",
      "bunny.net",
      "b-cdn.net",
      "vimeo.com",
      "wistia.com",
      "wistia.net",
      "youtube.com",
      "dailymotion.com"
    ].some(domain => src.toLowerCase().includes(domain));

    if (!isMediaHost) return;

    const allow = iframe.getAttribute("allow") || "";
    if (!allow.includes("autoplay")) {
      iframe.setAttribute("allow", allow ? allow + "; autoplay" : "autoplay");
      console.log(`${LOG} Added allow="autoplay" to iframe: ${src}`);
      
      // Force iframe reload to apply the new autoplay attribute
      iframe.src = "";
      iframe.src = src;
    }
  } catch (e) {
    console.error(`${LOG} Error enriching iframe autoplay permission:`, e);
  }
}

function processVideoElement(video) {
  if (pillRegistry.has(video)) return;
  createPill(video);
}

function createPill(video) {
  if (pillRegistry.has(video)) return;
  console.log(`${LOG} Creating pill for video`);

  const savedOffset = loadDragOffset();
  const instance = {
    video: video,
    element: null,
    state: STATE_PILL,
    dragOffset: { ...savedOffset },
    isVisible: true, // Default to true for instant rendering
    isHovered: false,
    isVideoHovered: false,
    anchorRight: false,
    anchorBottom: false,
    cachedUrl: null,
    cachedData: null,
    menuHoverTimer: null,
  };

  // Trigger activity to show the newly created pill for 6 seconds
  triggerActivity(6000);

  const wrapper = document.createElement("div");
  wrapper.className = "pill-instance";

  const pillContent = document.createElement("div");
  pillContent.className = "pill-content";
  pillContent.innerHTML = `
    <svg class="pill-icon" viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
    <span class="pill-text">Download</span>
  `;

  pillContent.addEventListener("mousedown", (e) => {
    if (e.button !== 0 || instance.state !== STATE_PILL) return;
    e.preventDefault();

    let isDragging = false;
    const startX = e.clientX;
    const startY = e.clientY;

    const initialOffset = { ...instance.dragOffset };

    const onMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;

      // Strict drag threshold
      if (!isDragging && Math.hypot(dx, dy) > 5) {
        isDragging = true;
      }

      if (isDragging) {
        instance.dragOffset.x = initialOffset.x + dx;
        instance.dragOffset.y = initialOffset.y + dy;
        saveDragOffset(instance.dragOffset);
        schedulePositionUpdate();
      }
    };

    const onMouseUp = (upEvent) => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);

      if (!isDragging) {
        openMenu(instance);
      }
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  });

  const menuContent = document.createElement("div");
  menuContent.className = "menu-content";

  wrapper.appendChild(pillContent);
  wrapper.appendChild(menuContent);

  uiContainer.appendChild(wrapper);
  instance.element = wrapper;

  pillRegistry.set(video, instance);

  wrapper.addEventListener("mouseenter", () => {
    instance.isHovered = true;
    updateAllPillsVisibility();
  });
  wrapper.addEventListener("mouseleave", () => {
    instance.isHovered = false;
    updateAllPillsVisibility();
  });

  video.addEventListener("mouseenter", () => {
    instance.isVideoHovered = true;
    updateAllPillsVisibility();
  });
  video.addEventListener("mouseleave", () => {
    instance.isVideoHovered = false;
    updateAllPillsVisibility();
  });

  if (resizeObserver) resizeObserver.observe(video);
  if (intersectionObserver) intersectionObserver.observe(video);

  schedulePositionUpdate();
}

// SPA grace period: defer pill destruction to allow seamless video element swaps
let pendingDestroys = new Map(); // video → timeoutId

function destroyPill(video) {
  const instance = pillRegistry.get(video);
  if (!instance) return;

  // Don't destroy immediately — give SPA 2000ms to insert a replacement <video>
  if (pendingDestroys.has(video)) return; // already scheduled

  const timeoutId = setTimeout(() => {
    pendingDestroys.delete(video);

    // Check if a new video appeared and we should transfer instead of destroying
    const allVideos = document.querySelectorAll("video");
    let replacementVideo = null;
    for (const v of allVideos) {
      if (!pillRegistry.has(v) && v !== video) {
        const rect = v.getBoundingClientRect();
        if (rect.width >= 50 && rect.height >= 50) {
          replacementVideo = v;
          break;
        }
      }
    }

    if (replacementVideo) {
      // Transfer: re-bind the pill to the new video element
      console.log(`${LOG} Transferring pill to new video element (SPA swap)`);
      pillRegistry.delete(video);
      if (resizeObserver) { resizeObserver.unobserve(video); resizeObserver.observe(replacementVideo); }
      if (intersectionObserver) { intersectionObserver.unobserve(video); intersectionObserver.observe(replacementVideo); }
      instance.video = replacementVideo;
      pillRegistry.set(replacementVideo, instance);
      triggerActivity(6000); // Re-arm idle activity timer for transferred pill instance
      schedulePositionUpdate();
      return;
    }

    // No replacement found — actually destroy
    console.log(`${LOG} Destroying pill (no replacement found)`);
    if (resizeObserver) resizeObserver.unobserve(video);
    if (intersectionObserver) intersectionObserver.unobserve(video);
    if (instance.closeHandlers) removeMenuCloseTriggers(instance);
    if (instance.element && instance.element.parentNode) {
      instance.element.parentNode.removeChild(instance.element);
    }
    pillRegistry.delete(video);
  }, 2000);

  pendingDestroys.set(video, timeoutId);
}

// --- Phase 3: True Morphing Expansion ---

function openMenu(instance) {
  if (instance.state === STATE_MENU) return;
  instance.state = STATE_MENU;

  const rect = instance.element.getBoundingClientRect();

  // Explicitly measure available space
  const spaceLeft = rect.left;
  const spaceRight = window.innerWidth - rect.right;
  const spaceTop = rect.top;
  const spaceBottom = window.innerHeight - rect.bottom;

  // Decide anchor edges based on available space to allow CSS max-width expansion safely
  instance.anchorRight = spaceLeft > spaceRight;
  instance.anchorBottom = spaceTop > spaceBottom;

  // Re-sync position with the new anchors immediately
  updatePillPosition(instance);

  instance.element.classList.add("state-menu");

  const menu = instance.element.querySelector(".menu-content");
  const videoUrl = window.location.href;

  if (instance.cachedUrl === videoUrl && instance.cachedData) {
    renderFormats(instance, instance.cachedData);
  } else {
    menu.innerHTML = '<div class="loading-text">Fetching formats...</div>';

    // Predictive rendering: instantly render raw M3U8 if available
    chrome.runtime.sendMessage({ action: "GET_RAW_STREAM" }, (rawResp) => {
      if (rawResp && rawResp.ok && instance.state === STATE_MENU) {
        const fakeData = {
          options: [
            {
              type: "video",
              format_id: "raw-intercept",
              label: "🎬 Master Stream (Adaptive)",
              badge: "RAW",
              vcodec: "unknown",
              acodec: "unknown",
              ext: "m3u8",
            },
          ],
        };
        renderFormats(instance, fakeData);

        const loadingMsg = document.createElement("div");
        loadingMsg.className = "loading-text";
        loadingMsg.innerText = "Extracting more formats...";
        menu.appendChild(loadingMsg);
      }
    });

    chrome.runtime.sendMessage(
      { action: "GET_HYBRID_STREAMS", url: videoUrl },
      (response) => {
        if (response && response.ok) {
          instance.cachedUrl = videoUrl;
          instance.cachedData = response.data;
        }

        if (instance.state !== STATE_MENU) return;
        if (chrome.runtime.lastError || !response || !response.ok) {
          if (!menu.querySelector(".format-btn")) {
            menu.innerHTML = `<div class="loading-text" style="color: var(--accent-red)">Failed to fetch formats</div>`;
          } else {
            const loadNode = menu.querySelector(".loading-text");
            if (loadNode) loadNode.style.display = "none";
          }
          return;
        }
        renderFormats(instance, response.data);
      },
    );
  }

  setupMenuCloseTriggers(instance);
}

function closeMenu(instance) {
  if (instance.state !== STATE_MENU) return;
  instance.state = STATE_PILL;
  instance.element.classList.remove("state-menu");

  // Revert anchor edges
  instance.element.style.right = "auto";
  instance.element.style.bottom = "auto";
  schedulePositionUpdate();

  removeMenuCloseTriggers(instance);
  updateAllPillsVisibility();
}

function renderFormats(instance, data) {
  const menu = instance.element.querySelector(".menu-content");
  if (!data || !data.options || data.options.length === 0) {
    if (!menu.querySelector(".format-btn")) {
      menu.innerHTML =
        '<div class="loading-text">No download options found.</div>';
    } else {
      const loadNode = menu.querySelector(".loading-text");
      if (loadNode) loadNode.style.display = "none";
    }
    return;
  }

  menu.innerHTML = ""; // Nuke the video title header to prevent RTL layout bugs
  const list = document.createElement("div");
  list.className = "format-list";

  data.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = `format-btn ${opt.type === "audio" ? "audio" : "video"}`;
    if (idx === 0) btn.classList.add("recommended");

    btn.setAttribute("data-format-id", opt.format_id);

    let height = 0;
    if (opt.resolution) {
      const parts = opt.resolution.toLowerCase().split("x");
      height = parseInt(parts[parts.length - 1]) || 0;
    }

    let badgeHtml = "";
    if (opt.badge) {
      badgeHtml = `<span class="badge badge-${opt.badge.toLowerCase()}">${opt.badge}</span>`;
    } else if (height > 0) {
      let fallbackBadge = "sd";
      if (height >= 2160) fallbackBadge = "4k";
      else if (height >= 1440) fallbackBadge = "qhd";
      else if (height >= 1080) fallbackBadge = "hd";
      else if (height >= 720) fallbackBadge = "hq";
      if (height >= 720)
        badgeHtml = `<span class="badge badge-${fallbackBadge}">${fallbackBadge.toUpperCase()}</span>`;
    } else if (opt.type === "audio") {
      badgeHtml = `<span class="badge badge-audio">AUDIO</span>`;
    }

    const ext = opt.ext ? opt.ext.toUpperCase() : "MP4";
    const size = opt.filesize
      ? (opt.filesize / 1024 / 1024).toFixed(1) + " MB"
      : "";
    const detailsText = [
      ext,
      size,
      opt.vcodec !== "none" ? opt.vcodec : opt.acodec,
    ]
      .filter(Boolean)
      .join(" • ");

    let displayLabel = opt.label || (height > 0 ? `${height}p` : "Audio");

    btn.innerHTML = `
      <span class="quality-label">${displayLabel}</span>
      <span class="format-details">${detailsText}</span>
      ${badgeHtml}
    `;

    list.appendChild(btn);
  });

  menu.appendChild(list);
}

function setupMenuCloseTriggers(instance) {
  instance.closeHandlers = {
    documentClick: (e) => {
      if (e.target !== uiHost) closeMenu(instance);
    },
    shadowClick: (e) => {
      const path = e.composedPath();
      if (!path.includes(instance.element)) closeMenu(instance);
    },
    escKey: (e) => {
      if (e.key === "Escape") closeMenu(instance);
    },
    mouseEnter: () => {
      if (instance.menuHoverTimer) clearTimeout(instance.menuHoverTimer);
    },
    mouseLeave: () => {
      if (instance.menuHoverTimer) clearTimeout(instance.menuHoverTimer);
      instance.menuHoverTimer = setTimeout(() => closeMenu(instance), 400);
    },
  };

  document.addEventListener("mousedown", instance.closeHandlers.documentClick, {
    capture: true,
  });
  uiContainer.addEventListener(
    "mousedown",
    instance.closeHandlers.shadowClick,
    { capture: true },
  );
  document.addEventListener("keydown", instance.closeHandlers.escKey, {
    capture: true,
  });

  instance.element.addEventListener(
    "mouseenter",
    instance.closeHandlers.mouseEnter,
  );
  instance.element.addEventListener(
    "mouseleave",
    instance.closeHandlers.mouseLeave,
  );
}

function removeMenuCloseTriggers(instance) {
  if (instance.closeHandlers) {
    document.removeEventListener(
      "mousedown",
      instance.closeHandlers.documentClick,
      { capture: true },
    );
    uiContainer.removeEventListener(
      "mousedown",
      instance.closeHandlers.shadowClick,
      { capture: true },
    );
    document.removeEventListener("keydown", instance.closeHandlers.escKey, {
      capture: true,
    });

    instance.element.removeEventListener(
      "mouseenter",
      instance.closeHandlers.mouseEnter,
    );
    instance.element.removeEventListener(
      "mouseleave",
      instance.closeHandlers.mouseLeave,
    );

    if (instance.menuHoverTimer) clearTimeout(instance.menuHoverTimer);

    instance.closeHandlers = null;
  }
}

function setupGlobalInteractions() {
  uiContainer.addEventListener("click", (e) => {
    const btn = e.target.closest(".format-btn");
    if (!btn) return;

    const instanceElement = btn.closest(".pill-instance");
    if (!instanceElement) return;

    let targetInstance = null;
    for (const inst of pillRegistry.values()) {
      if (inst.element === instanceElement) {
        targetInstance = inst;
        break;
      }
    }
    if (!targetInstance) return;

    const url = window.location.href;
    const formatId = btn.getAttribute("data-format-id");
    if (!formatId) return;

    const engineType = formatId === "raw-intercept" ? "m3u8" : "ytdlp";
    const sanitizedTitle = sanitizePageTitle();

    btn.classList.add("dispatching");
    const allBtns = instanceElement.querySelectorAll(".format-btn");
    allBtns.forEach((b) => (b.disabled = true));

    chrome.storage.local.get(["thunder_grab_save_dir", "thunder_grab_auto_start"], (config) => {
      const payload = { url: url, format_id: formatId, engine: engineType, page_url: window.location.href };
      if (sanitizedTitle) payload.title = sanitizedTitle;
      if (config.thunder_grab_save_dir) payload.download_dir = config.thunder_grab_save_dir;
      payload.auto_download = config.thunder_grab_auto_start !== "false";

      chrome.runtime.sendMessage(
        {
          action: "TRIGGER_DOWNLOAD",
          payload: payload,
        },
        (response) => {
          if (chrome.runtime.lastError || (response && !response.ok)) {
            console.error(`${LOG} Download trigger failed`);
            btn.innerHTML = '<span style="color:var(--accent-red)">Failed</span>';
            btn.classList.remove("dispatching");
            setTimeout(() => closeMenu(targetInstance), 1500);
            return;
          }
          closeMenu(targetInstance);
        },
      );
    });
  });
}

function sanitizePageTitle() {
  let raw = "";
  
  // 1. Try to find the matched sidebar lesson text first (most accurate for course files)
  try {
    const links = getAllLessonLinks();
    const currentIdx = getCurrentLessonIndex(links);
    if (currentIdx !== -1 && links[currentIdx] && links[currentIdx].text) {
      raw = links[currentIdx].text;
    }
  } catch (e) {
    console.error(`${LOG} Error matching title from sidebar links:`, e);
  }
  
  // 2. Fallback to prominent h1 title (often the course or video name)
  if (!raw) {
    const h1 = document.querySelector("h1");
    if (h1 && h1.innerText && h1.innerText.trim()) {
      raw = h1.innerText.trim();
    }
  }
  
  // 3. Fallback to document.title
  if (!raw) {
    raw = document.title;
  }

  // 4. Fallback to URL slug if generic
  if (!raw || typeof raw !== "string" || raw.trim().toLowerCase() === "cloud native base camp") {
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) {
      const slug = pathParts[pathParts.length - 1];
      raw = slug.replace(/-/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    }
  }

  if (!raw || typeof raw !== "string") return null;

  // Cleanup: Remove common suffixes
  const suffixes = [
    " - YouTube",
    " | Prime Video",
    " - Dailymotion",
    " - Watch Online",
    " - Crunchyroll",
    " - Netflix",
    " - Watch Free",
    " · GitHub",
  ];

  for (const suffix of suffixes) {
    if (raw.endsWith(suffix)) {
      raw = raw.substring(0, raw.length - suffix.length);
      break;
    }
  }

  // Clean title for clean filename (remove durations, emojis, checkmarks, etc.)
  let clean = raw;
  
  // Remove durations like (12:34) or 12:34 or [12:34]
  clean = clean.replace(/\[?\b\d+:\d+(:\d+)?\b\]?/g, "");
  
  // Remove duration suffixes like 15m, 15 min, (15 min), [15m]
  clean = clean.replace(/\[?\b\d+\s*(m|min|s|sec|mins)\b\]?/g, "");
  
  // Remove common symbols/emojis/bullets
  clean = clean.replace(/[✔▶►●○•■□▪▫#|✔🔒]/g, "");
  
  // Remove common status words (case insensitive, Arabic/English)
  clean = clean.replace(/\b(completed|complete|done|locked|free|preview|السابق|التالي|تم\s*إنجازه|تمت\s*مشاهدته)\b/gi, "");

  // Replace shell operators to avoid any terminal command breaking if filename is copied or parsed in scripts
  clean = clean.replace(/&&/g, "and").replace(/\|\|/g, "or");
  clean = clean.replace(/&/g, "and").replace(/\|/g, "or");
  
  // Strip invalid characters for filesystems
  clean = clean.replace(/[/\\:*?"<>]/g, "").trim();
  clean = clean.replace(/\s+/g, " ");
  
  if (clean.length > 200) clean = clean.substring(0, 200).trim();
  
  return clean || null;
}

// ─── Sequential Auto-Grabber v2 ───────────────────────────────────────
// Tracks position by index, mimics human behavior, Cloudflare-aware

let grabOverlay = null;

// ── Human-like delay utilities ──────────────────────────────────────
function humanDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise(r => setTimeout(r, ms));
}

function humanScroll() {
  // Scroll down a bit, then back up — mimics a real user reading the page
  const scrollAmount = 100 + Math.random() * 300;
  window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
  return humanDelay(800, 1500).then(() => {
    window.scrollBy({ top: -scrollAmount * 0.3, behavior: 'smooth' });
  });
}

function simulateMouseMove() {
  // Dispatch a few synthetic mousemove events at random positions
  for (let i = 0; i < 3; i++) {
    const x = 100 + Math.random() * (window.innerWidth - 200);
    const y = 100 + Math.random() * (window.innerHeight - 200);
    document.dispatchEvent(new MouseEvent('mousemove', {
      clientX: x, clientY: y, bubbles: true
    }));
  }
}

// ── Overlay UI ──────────────────────────────────────────────────────
let islandStatusLocked = false;
let islandTimeout = null;

function expandIsland() {
  const el = document.getElementById("thunder-grab-overlay");
  if (el) {
    el.className = "expanded";
  }
}

function collapseIsland() {
  const el = document.getElementById("thunder-grab-overlay");
  if (el) {
    el.className = "compact";
  }
}

function triggerIslandPulse() {
  const el = document.getElementById("thunder-grab-overlay");
  if (el) {
    el.style.boxShadow = "0 12px 30px rgba(56, 189, 248, 0.45), 0 0 0 2px #38bdf8";
    setTimeout(() => {
      if (el) el.style.boxShadow = "";
    }, 550);
  }
}

function showGrabOverlay() {
  if (document.getElementById("thunder-grab-overlay")) return;

  grabOverlay = document.createElement("div");
  grabOverlay.id = "thunder-grab-overlay";
  grabOverlay.className = "compact"; // Start in compact pill mode
  
  grabOverlay.innerHTML = `
    <!-- Compact View -->
    <div id="view-compact" class="island-view">
      <div style="display: flex; align-items: center; gap: 8px; flex: 1;">
        <span style="color: #38bdf8; font-size: 14px; display: inline-block; animation: island-pulse 2s infinite; user-select: none;">⚡</span>
        <span id="island-compact-text" style="font-size: 11px; font-weight: 800; letter-spacing: 1px; color: #38bdf8; user-select: none;">THUNDER</span>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <span id="island-compact-counter" style="font-size: 10px; color: #94a3b8; font-weight: 600; user-select: none;"></span>
        <span style="width: 6px; height: 6px; background: #10b981; border-radius: 50%; display: inline-block; animation: island-dot-pulse 1.5s infinite;"></span>
      </div>
    </div>

    <!-- Expanded View -->
    <div id="view-expanded" class="island-view" style="justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1;">
        <span class="island-spinner" style="
          display: inline-block;
          width: 18px; height: 18px;
          border: 2.5px solid #38bdf8;
          border-top-color: transparent;
          border-radius: 50%;
          animation: island-spin 0.8s linear infinite;
          flex-shrink: 0;
        "></span>
        <div style="display: flex; flex-direction: column; min-width: 0; text-align: left;">
          <span id="island-status-text" style="font-size: 13px; font-weight: 600; color: #ffffff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; font-family: -apple-system, sans-serif;">Scanning...</span>
          <span id="island-subtitle-text" style="font-size: 10px; color: #94a3b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block;">Auto-Grabber Active</span>
        </div>
      </div>
      <button id="thunder-grab-cancel" style="
        background: rgba(255,255,255,0.15) !important;
        border: none !important;
        color: #ffffff !important;
        cursor: pointer !important;
        width: 24px !important;
        height: 24px !important;
        border-radius: 50% !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-size: 10px !important;
        margin-left: 12px !important;
        transition: all 0.2s !important;
        flex-shrink: 0;
      ">✕</button>
    </div>
  `;

  if (!document.getElementById("thunder-grab-style")) {
    const style = document.createElement("style");
    style.id = "thunder-grab-style";
    style.textContent = `
      #thunder-grab-overlay {
        position: fixed !important;
        top: 15px !important;
        left: 50% !important;
        transform: translateX(-50%) !important;
        background: #000000 !important;
        box-shadow: 0 12px 30px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.12) !important;
        z-index: 2147483647 !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
        color: #ffffff !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
        pointer-events: auto !important;
        cursor: pointer !important;
        
        /* Apple Dynamic Island Spring Animation */
        transition: width 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), 
                    height 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275), 
                    border-radius 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275),
                    box-shadow 0.3s ease !important;
      }

      /* Compact Pill Mode */
      #thunder-grab-overlay.compact {
        width: 145px !important;
        height: 34px !important;
        border-radius: 17px !important;
      }

      /* Expanded Capsule Mode */
      #thunder-grab-overlay.expanded {
        width: 380px !important;
        height: 56px !important;
        border-radius: 22px !important;
      }

      .island-view {
        position: absolute !important;
        left: 0 !important;
        top: 50% !important;
        transform: translateY(-50%) scale(0.85) !important;
        width: 100% !important;
        opacity: 0 !important;
        pointer-events: none !important;
        transition: opacity 0.35s cubic-bezier(0.25, 1, 0.5, 1), transform 0.35s cubic-bezier(0.25, 1, 0.5, 1) !important;
        box-sizing: border-box !important;
        display: flex !important;
        align-items: center !important;
        padding: 0 16px !important;
      }

      #thunder-grab-overlay.compact #view-compact {
        opacity: 1 !important;
        pointer-events: auto !important;
        transform: translateY(-50%) scale(1) !important;
      }

      #thunder-grab-overlay.expanded #view-expanded {
        opacity: 1 !important;
        pointer-events: auto !important;
        transform: translateY(-50%) scale(1) !important;
      }

      @keyframes island-spin {
        to { transform: rotate(360deg); }
      }

      @keyframes island-pulse {
        0% { transform: scale(1); opacity: 0.8; }
        50% { transform: scale(1.15); opacity: 1; }
        100% { transform: scale(1); opacity: 0.8; }
      }

      @keyframes island-dot-pulse {
        0% { transform: scale(1); opacity: 0.5; }
        50% { transform: scale(1.3); opacity: 1; box-shadow: 0 0 6px #10b981; }
        100% { transform: scale(1); opacity: 0.5; }
      }

      #thunder-grab-cancel:hover {
        background: rgba(255, 255, 255, 0.22) !important;
        transform: scale(1.05);
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(grabOverlay);

  // Setup hover actions to morph Dynamic Island
  grabOverlay.onmouseenter = () => {
    expandIsland();
  };
  grabOverlay.onmouseleave = () => {
    if (!islandStatusLocked) {
      collapseIsland();
    }
  };

  document.getElementById("thunder-grab-cancel").onclick = (e) => {
    e.stopPropagation();
    chrome.storage.local.set({
      thunder_grab_active: "false",
      thunder_grab_index: 0,
      thunder_grab_urls: []
    }, () => {
      removeGrabOverlay();
      console.log(`${LOG} Auto-grab cancelled by user.`);
    });
  };
}

function updateGrabStatus(msg) {
  const statusText = document.getElementById("island-status-text");
  if (statusText) {
    statusText.textContent = msg;
    
    // Auto expand on status change to show update
    expandIsland();
    triggerIslandPulse();
    
    islandStatusLocked = true;
    if (islandTimeout) clearTimeout(islandTimeout);
    islandTimeout = setTimeout(() => {
      islandStatusLocked = false;
      const el = document.getElementById("thunder-grab-overlay");
      if (el && !el.matches(':hover')) {
        collapseIsland();
      }
    }, 3500);
  }
}

function updateGrabCounter(current, total) {
  const counterEl = document.getElementById("island-compact-counter");
  if (counterEl) {
    counterEl.textContent = `${current}/${total}`;
  }
  const subtitleText = document.getElementById("island-subtitle-text");
  if (subtitleText) {
    subtitleText.textContent = `Lesson ${current} of ${total}`;
  }
}

function removeGrabOverlay() {
  const el = document.getElementById("thunder-grab-overlay");
  if (el) el.remove();
}

function cleanTitleForComparison(title) {
  if (!title) return "";
  return title.toLowerCase()
    .replace(/\b\d+:\d+\b/g, "")
    .replace(/\b\d+\s*(m|min|s|sec)\b/g, "")
    .replace(/[✔▶►●○•■□▪▫#|–\-]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

function isTitleCompleted(linkText, completedTitles) {
  const cleanLink = cleanTitleForComparison(linkText);
  if (!cleanLink) return false;
  
  return completedTitles.some(title => {
    const cleanComp = cleanTitleForComparison(title);
    if (!cleanComp) return false;
    return cleanLink.includes(cleanComp) || cleanComp.includes(cleanLink);
  });
}

function getAllLessonLinks() {
  // Collect ALL unique lesson links from the page sidebar/list
  // Support common patterns: /lessons/, /lecture/, /chapter/
  const selectors = [
    'a[href*="/lessons/"]',
    'a[href*="/lecture/"]',
    'a[href*="/chapter/"]',
    'a[href*="/lesson/"]',
    'a[href*="/video/"]',
    'a[href*="/watch/"]',
  ];
  
  // Get all candidate links from the whole document first
  let docLinks = [];
  for (const sel of selectors) {
    const found = document.querySelectorAll(sel);
    for (const a of found) {
      docLinks.push(a);
    }
  }
  
  // Get candidate links from sidebar/curriculum containers (excluding nav)
  const sidebarContainers = document.querySelectorAll('aside, [class*="sidebar"], [class*="curriculum"], [class*="lessons-list"], [class*="course-outline"], [id*="sidebar"], [id*="curriculum"]');
  let containerLinks = [];
  for (const container of sidebarContainers) {
    if (container.closest('header, footer, .header, .footer')) continue;
    for (const sel of selectors) {
      const found = container.querySelectorAll(sel);
      for (const a of found) {
        containerLinks.push(a);
      }
    }
  }
  
  // Helper to filter and normalize candidate links
  const processLinks = (linksArray) => {
    const processed = [];
    const seenHrefs = new Set();
    for (const a of linksArray) {
      try {
        // Skip header, footer, and navigation wrapper elements
        if (a.closest('header, footer, .header, .footer, [class*="nav-buttons"], [class*="pagination"]')) {
          continue;
        }
        
        const text = (a.textContent || a.innerText || '').trim();
        // Skip text-based navigation and completion buttons
        if (/^(prev|next|previous|السابق|التالي|go\s*back|continue|←|→)$/i.test(text) || /^(complete|mark\s*as\s*complete)$/i.test(text)) {
          continue;
        }
        
        const url = new URL(a.href, location.origin);
        const normalized = url.origin + url.pathname.replace(/\/+$/, '');
        if (!seenHrefs.has(normalized)) {
          seenHrefs.add(normalized);
          processed.push({ el: a, href: url.href, normalized: normalized, text: text });
        }
      } catch {}
    }
    return processed;
  };
  
  const processedContainers = processLinks(containerLinks);
  const processedDoc = processLinks(docLinks);
  
  // If container search found a good number of links (e.g. >= 3), use it (sidebar list is more specific).
  // Otherwise, fallback to the whole document search (e.g. on course main page).
  if (processedContainers.length >= 3) {
    return processedContainers;
  }
  return processedDoc;
}

function getCurrentLessonIndex(links) {
  if (!links || links.length === 0) return -1;

  // 1. Check DOM active state (extremely reliable for SPA/LMS navigations)
  const activeIdx = links.findIndex(l => {
    if (!l.el) return false;
    const el = l.el;
    const classList = Array.from(el.classList).map(c => c.toLowerCase());
    const isActiveClass = (str) => /active|current|selected|playing|is-active/i.test(str);
    
    if (classList.some(isActiveClass)) return true;
    if (el.getAttribute("aria-current") === "page" || el.getAttribute("aria-selected") === "true") return true;
    
    let parent = el.parentElement;
    for (let depth = 0; depth < 3 && parent; depth++) {
      const parentClasses = Array.from(parent.classList).map(c => c.toLowerCase());
      if (parentClasses.some(isActiveClass)) return true;
      parent = parent.parentElement;
    }
    return false;
  });
  if (activeIdx !== -1) return activeIdx;

  // Helper to normalize URLs for robust path comparisons
  const normalize = (u) => {
    try {
      const parsed = new URL(u, location.origin);
      return parsed.pathname.toLowerCase()
        .replace(/\/+$/, '')
        .replace(/[–—]/g, '-') // Normalize medium/long dashes to standard hyphens
        .replace(/[^a-z0-9/]/g, ''); // Strip other characters to handle loose formatting
    } catch {
      return '';
    }
  };

  const currentPath = normalize(location.href);

  // 2. Try exact normalized match
  const exactIdx = links.findIndex(l => normalize(l.href) === currentPath);
  if (exactIdx !== -1) return exactIdx;

  // 3. Loose fallback match (slug similarity)
  return links.findIndex(l => {
    const linkPath = normalize(l.href);
    if (linkPath.length <= 8) return false;
    return currentPath.includes(linkPath) || linkPath.includes(currentPath);
  });
}

function findNextLesson() {
  const links = getAllLessonLinks();
  if (links.length === 0) {
    console.log(`${LOG} No lesson links found on page.`);
    return null;
  }

  const currentIdx = getCurrentLessonIndex(links);
  const savedIdx = parseInt(sessionStorage.getItem("thunder_grab_index") || "-1");
  
  console.log(`${LOG} Found ${links.length} lesson links. Current page index: ${currentIdx}, Saved index: ${savedIdx}`);
  
  // Determine the NEXT index — must always go forward
  let nextIdx;
  if (currentIdx !== -1) {
    // We found our current page in the list — next is simply currentIdx + 1
    nextIdx = currentIdx + 1;
  } else if (savedIdx >= 0) {
    // Page isn't in list (maybe URL mismatch) — use saved index + 1
    nextIdx = savedIdx + 1;
  } else {
    // First run: start from 0
    nextIdx = 0;
  }
  
  if (nextIdx >= links.length) {
    console.log(`${LOG} No more lessons after index ${nextIdx}. Course complete!`);
    return null;
  }

  const next = links[nextIdx];
  console.log(`${LOG} Next lesson [${nextIdx}]: "${next.text}" → ${next.href}`);
  
  // Save index so we ALWAYS move forward even after page reload
  sessionStorage.setItem("thunder_grab_index", String(nextIdx));
  
  return { el: next.el, href: next.href, index: nextIdx, total: links.length };
}

// ── Also check for explicit "Next" / "Complete" buttons ─────────────
function findCompletionButton() {
  // Look for a "Mark Complete" or "Complete & Continue" button specifically
  // Include standard button elements and links (which are often styled as buttons)
  const buttons = document.querySelectorAll('button, [role="button"], a');
  
  const completionRegex = /^(complete|mark.*(complete|done)|finish|next\s*lesson|continue\s*to\s*next)/i;
  const excludeRegex = /previous|back|prev|login|sign|share|report/i;
  
  for (const btn of buttons) {
    const style = window.getComputedStyle(btn);
    if (style.display === 'none' || style.visibility === 'hidden' || btn.offsetWidth === 0) continue;
    
    const text = (btn.textContent || btn.value || btn.getAttribute("aria-label") || "").trim();
    if (text.length > 80) continue; // Skip large containers that match accidentally
    
    if (completionRegex.test(text) && !excludeRegex.test(text)) {
      console.log(`${LOG} Found completion button: "${text}"`);
      return btn;
    }
  }
  
  return null;
}

// ── Playback Helper ─────────────────────────────────────────────────
function triggerVideoPlayback() {
  try {
    // 1. Direct video tag play
    const videos = document.querySelectorAll('video');
    videos.forEach(video => {
      video.muted = true;
      video.play().then(() => {
        console.log(`${LOG} Auto-played video tag (muted)`);
      }).catch(err => {
        console.log(`${LOG} Video play() failed:`, err);
      });
    });

    // 2. Click standard play buttons/overlays
    const playSelectors = [
      '.vp-play-button',
      '.vp-preview',
      '.video-js .vjs-big-play-button',
      '.plyr__control--overlaid',
      '.play-button',
      'button[aria-label="Play"]',
      'button[aria-label="تشغيل"]',
      '[class*="play-button"]',
      '[class*="play_button"]',
      '[class*="big-play"]',
      'svg[class*="play"]',
      '.w-vulcan-v2-button'
    ];
    playSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(btn => {
        try {
          btn.click();
          console.log(`${LOG} Clicked play button selector: ${sel}`);
        } catch {}
      });
    });

    // 3. Click video containers (forces player event handlers to trigger toggle-play)
    const containerSelectors = [
      '.video-wrapper',
      '.video-container',
      '.player-container',
      '[class*="player"]',
      '[class*="video-wrap"]'
    ];
    containerSelectors.forEach(sel => {
      document.querySelectorAll(sel).forEach(c => {
        try {
          c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          console.log(`${LOG} Dispatched click event to container: ${sel}`);
        } catch {}
      });
    });

    // 4. Send postMessage commands to any iframe players (Vimeo / Wistia / YouTube)
    document.querySelectorAll('iframe').forEach(iframe => {
      try {
        const src = iframe.src || '';
        if (src.includes('vimeo.com')) {
          iframe.contentWindow.postMessage('{"method":"play"}', '*');
          console.log(`${LOG} Sent play command to Vimeo iframe`);
        } else if (src.includes('wistia')) {
          iframe.contentWindow.postMessage('{"command":"play"}', '*');
          console.log(`${LOG} Sent play command to Wistia iframe`);
        } else if (src.includes('youtube.com')) {
          iframe.contentWindow.postMessage('{"event":"command","func":"playVideo","args":""}', '*');
          console.log(`${LOG} Sent play command to YouTube iframe`);
        } else if (src.includes('mediadelivery.net') || src.includes('b-cdn.net')) {
          iframe.contentWindow.postMessage(
            JSON.stringify({ context: 'player.js', version: '0.0.11', method: 'play' }),
            '*'
          );
          console.log(`${LOG} Sent player.js play command to Bunny Stream iframe`);
        }
      } catch {}
    });
  } catch (e) {
    console.error(`${LOG} Error trying to auto-play video:`, e);
  }
}

function finishGrab() {
  isGrabInProgress = false;
  chrome.storage.local.set({
    thunder_grab_active: "false",
    thunder_grab_index: 0,
    thunder_grab_urls: []
  }, () => {
    removeGrabOverlay();
    
    // Show completion banner
    const banner = document.createElement("div");
    banner.style.cssText = `
      position: fixed; top: 24px; left: 50%; transform: translateX(-50%);
      background: linear-gradient(135deg, #a6e3a1, #94e2d5); color: #1e1e2e;
      padding: 14px 28px; border-radius: 30px; font-weight: 700; font-size: 15px;
      font-family: system-ui, sans-serif; z-index: 2147483647;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4); pointer-events: auto;
    `;
    banner.textContent = "⚡ Thunder: Course download complete!";
    document.body.appendChild(banner);
    setTimeout(() => banner.remove(), 8000);
  });
}

// ── Main grab loop ──────────────────────────────────────────────────
let isGrabInProgress = false;

async function handleAutoGrab() {
  if (isGrabInProgress) {
    console.log(`${LOG} handleAutoGrab() already running. Skipping duplicate invocation.`);
    return;
  }
  isGrabInProgress = true;
  console.log(`${LOG} handleAutoGrab() triggered on ${location.href}`);
  showGrabOverlay();
  
  chrome.storage.local.get(["thunder_grab_active", "thunder_grab_urls", "thunder_grab_index"], async (store) => {
    if (store.thunder_grab_active !== "true") {
      isGrabInProgress = false;
      return;
    }

    const urls = store.thunder_grab_urls || [];
    let currentIdx = parseInt(store.thunder_grab_index || "0");
    updateGrabCounter(currentIdx + 1, urls.length > 0 ? urls.length : 1);

    // Align index logic removed to prevent infinite redirect loops
    
    // Step 1: Wait for Cloudflare turnstile/loading screen to clear
    updateGrabStatus("Waiting for Cloudflare verification...");
    simulateMouseMove();
    await humanDelay(3000, 5000); // 3-5 seconds is optimal for Cloudflare checks
    
    if (store.thunder_grab_active !== "true") {
      isGrabInProgress = false;
      return;
    }
    
    // Trigger video playback (helps bypass autoplay restriction)
    triggerVideoPlayback();
    
    // Step 2: Natural human scroll
    updateGrabStatus("Scanning video player...");
    await humanScroll();
    simulateMouseMove();
    await humanDelay(1500, 2500);
    
    triggerVideoPlayback();

    // Step 3: Wait for video stream interception (runs indefinitely or until cancelled)
    updateGrabStatus("Intercepting video stream...");
    let manifest = null;
    let secondsWaited = 0;
    while (true) {
      // Recheck active state in case user cancelled
      const activeState = await new Promise(r => {
        chrome.storage.local.get("thunder_grab_active", res => r(res ? res.thunder_grab_active : null));
      });
      if (activeState !== "true") return;

      manifest = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: "GET_RAW_STREAM" }, response => {
          resolve(response?.ok && response?.data ? response.data : null);
        });
      });
      
      if (manifest) break;
      
      secondsWaited++;
      if (secondsWaited > 45) {
        console.warn(`${LOG} Stream interception timed out after 45s. Moving to next lesson.`);
        updateGrabStatus("Stream timeout (45s). Skipping to next lesson...");
        await humanDelay(1500, 2000);
        break;
      } else if (secondsWaited > 8) {
        updateGrabStatus("Waiting for Cloudflare Turnstile or Video Playback...");
      } else {
        updateGrabStatus("Intercepting keys...");
      }
      
      // Periodically trigger play in case player paused/idle
      if (secondsWaited % 3 === 0) triggerVideoPlayback();
      
      await humanDelay(1000, 1500);
    }

    // Step 4: Queue download
    if (manifest) {
      const title = sanitizePageTitle() || document.title;
      console.log(`${LOG} Captured stream: ${manifest.url.substring(0, 80)}...`);
      updateGrabStatus(`Downloading: ${title.substring(0, 30)}...`);
      
      await new Promise(resolve => {
        chrome.storage.local.get(["thunder_grab_save_dir", "thunder_grab_auto_start", "thunder_grab_course_name"], (config) => {
          const customSaveDir = config.thunder_grab_save_dir;
          const autoStartVal = config.thunder_grab_auto_start !== "false";
          const courseName = config.thunder_grab_course_name;
          
          let targetDir = customSaveDir || null;
          if (targetDir && courseName) {
            if (targetDir.endsWith('/') || targetDir.endsWith('\\')) {
              targetDir = targetDir + courseName;
            } else {
              targetDir = targetDir + (targetDir.includes('\\') ? '\\' : '/') + courseName;
            }
          }

          chrome.runtime.sendMessage({
            action: "TRIGGER_DOWNLOAD",
            payload: {
              url: "raw-intercept",
              format_id: "raw-intercept",
              engine: "m3u8",
              title: title,
              download_dir: targetDir,
              auto_download: autoStartVal
            }
          }, resolve);
        });
      });
      
      updateGrabStatus("Download queued ✓");
      await humanDelay(2000, 3500);
    }

    // Update index for next lesson
    const nextIdx = currentIdx + 1;
    await new Promise(resolve => {
      chrome.storage.local.set({ thunder_grab_index: nextIdx }, resolve);
    });

    // Step 5: Navigate to next page
    if (urls.length > 0) {
      if (nextIdx >= urls.length) {
        console.log(`${LOG} 🎉 Course completed!`);
        finishGrab();
      } else {
        // Look for completion/next button on page to mark progress on LMS
        const completionBtn = findCompletionButton();
        if (completionBtn) {
          updateGrabStatus("Marking lesson complete...");
          simulateMouseMove();
          await humanDelay(800, 1500);
          const oldUrl = location.href;
          completionBtn.click();
          await humanDelay(3500, 4500); // Wait for LMS navigation
          isGrabInProgress = false;
          
          // Only redirect if the URL hasn't changed (meaning the click didn't navigate us)
          if (location.href === oldUrl) {
            updateGrabCounter(nextIdx + 1, urls.length);
            updateGrabStatus(`Navigating to lesson ${nextIdx + 1}/${urls.length}...`);
            window.location.href = urls[nextIdx];
          }
        } else {
          updateGrabCounter(nextIdx + 1, urls.length);
          updateGrabStatus(`Navigating to lesson ${nextIdx + 1}/${urls.length}...`);
          isGrabInProgress = false;
          window.location.href = urls[nextIdx];
        }
      }
    } else {
      // Started directly on lesson page (no pre-saved curriculum list)
      const completionBtn = findCompletionButton();
      if (completionBtn) {
        updateGrabStatus("Marking lesson complete...");
        simulateMouseMove();
        await humanDelay(800, 1500);
        completionBtn.click();
        isGrabInProgress = false;
      } else {
        finishGrab();
      }
    }
  });
}

// ─── Setup listeners (main frame only) ────────────────────────────────

if (window === window.top) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "GET_MAIN_FRAME_TITLE") {
      sendResponse({ title: sanitizePageTitle() });
      return;
    }
    if (message.action === "START_AUTO_GRAB") {
      // 1. Get completed titles from backend
      chrome.runtime.sendMessage({ action: "GET_COMPLETED_TITLES" }, (response) => {
        const completedTitles = response?.ok ? (response.titles || []) : [];
        
        chrome.storage.local.set({
          thunder_grab_active: "true",
          thunder_grab_index: 0,
          thunder_grab_urls: []
        }, () => {
          // Collect links if we are on a curriculum outline page
          const links = getAllLessonLinks();
          if (links.length > 1) {
            const urls = links.map(l => l.href);
            
            // If the user is currently on one of the lesson pages, start crawling from there!
            const currentIdx = getCurrentLessonIndex(links);
            let startIdx = 0;
            let shouldRedirect = false;
            
            if (currentIdx !== -1) {
              startIdx = currentIdx;
            } else {
              // Find the FIRST uncompleted lesson link index
              for (let i = 0; i < links.length; i++) {
                if (!isTitleCompleted(links[i].text, completedTitles)) {
                  startIdx = i;
                  break;
                }
                startIdx = i + 1; // if all are completed, startIdx will exceed urls.length
              }
              
              // Check if we are already on a lesson page to avoid redirecting back
              const isCurrentlyOnLessonPage = location.pathname.includes("/lessons/") || 
                                           location.pathname.includes("/lesson/") || 
                                           location.pathname.includes("/lecture/") || 
                                           document.querySelector("video") !== null;

              if (!isCurrentlyOnLessonPage && startIdx < urls.length) {
                shouldRedirect = true;
              }
            }
            
            if (startIdx >= urls.length) {
              // Everything is already completed!
              chrome.storage.local.set({
                thunder_grab_active: "false"
              }, () => {
                alert("⚡ Thunder: All lessons in this course are already downloaded!");
              });
              sendResponse({ ok: true });
              return;
            }
            
            chrome.storage.local.set({
              thunder_grab_urls: urls,
              thunder_grab_index: startIdx
            }, () => {
              if (currentIdx === startIdx || !shouldRedirect) {
                console.log(`${LOG} Starting grab directly on current page.`);
                handleAutoGrab();
              } else {
                console.log(`${LOG} Curriculum page or non-lesson page. Redirecting to start lesson: ${urls[startIdx]}`);
                window.location.href = urls[startIdx];
              }
            });
          } else {
            // Fallback: started on single lesson page
            handleAutoGrab();
          }
          sendResponse({ ok: true });
        });
      });
      return true;
    }
  });

  // Resume grab after page navigation
  chrome.storage.local.get(["thunder_grab_active"], (res) => {
    if (res.thunder_grab_active === "true") {
      showGrabOverlay();
      updateGrabStatus("Page loading...");
      
      // Delay 5-8s to allow Cloudflare check to clear and player to mount.
      // Since content.js runs at document_idle, the DOM is already interactive/complete.
      const delay = 5000 + Math.random() * 3000;
      setTimeout(handleAutoGrab, delay);
    }
  });

  // Periodically check for URL changes (SPA transitions) in top frame
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      chrome.storage.local.get(["thunder_grab_active"], (res) => {
        if (res && res.thunder_grab_active === "true") {
          console.log(`${LOG} SPA transition detected: ${location.href}. Re-running handleAutoGrab.`);
          handleAutoGrab();
        }
      });
    }
  }, 1000);
} else {
  // Passive video play support inside iframe contexts
  chrome.storage.local.get(["thunder_grab_active"], (res) => {
    if (res && res.thunder_grab_active === "true") {
      console.log(`${LOG} Iframe grab helper active. Monitoring video tag...`);
      setInterval(() => {
        try {
          const video = document.querySelector('video');
          if (video && video.paused) {
            video.muted = true;
            video.play().then(() => {
              console.log(`${LOG} Iframe helper: Auto-played video tag (muted)`);
            }).catch(() => {});
          }
        } catch {}
      }, 1500);
    }
  });
}

init();

