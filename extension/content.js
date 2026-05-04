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
  uiHost.id = "thunder-host";
  uiHost.style.cssText = HOST_STYLE;

  shadowRoot = uiHost.attachShadow({ mode: "closed" });

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("content.css");
  shadowRoot.appendChild(link);

  uiContainer = document.createElement("div");
  uiContainer.id = "thunder-container";
  shadowRoot.appendChild(uiContainer);

  (document.body || document.documentElement).appendChild(uiHost);
  console.log(`${LOG} Host injected successfully.`);
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

  // Activity-Based Visibility Fix: Any mouse movement triggers the UI
  const triggerActivity = () => {
    if (!isUIActive) {
      isUIActive = true;
      updateAllPillsVisibility();

      // Predictive Pre-warming
      if (!preWarmSent || preWarmUrl !== window.location.href) {
        preWarmUrl = window.location.href;
        preWarmSent = true;
        chrome.runtime.sendMessage({ action: "PRE_WARM_URL", url: preWarmUrl });
      }
    }
    if (activityTimeout) clearTimeout(activityTimeout);
    activityTimeout = setTimeout(() => {
      isUIActive = false;
      updateAllPillsVisibility();
    }, 600); // 600ms debounce
  };

  document.addEventListener("mousemove", triggerActivity, {
    passive: true,
    capture: true,
  });
  document.addEventListener("mousedown", triggerActivity, {
    passive: true,
    capture: true,
  });
  document.addEventListener("keydown", triggerActivity, {
    passive: true,
    capture: true,
  });
  document.addEventListener("scroll", triggerActivity, {
    passive: true,
    capture: true,
  });
}

function updateAllPillsVisibility() {
  for (const instance of pillRegistry.values()) {
    if (!instance.isVisible) {
      instance.element.classList.remove("active");
      continue;
    }

    // Always visible if menu is open
    if (instance.state === STATE_MENU) {
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
  if (rect.width < 150 || rect.height < 150) {
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

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "VIDEO") {
            processVideoElement(node);
          } else {
            node.querySelectorAll("video").forEach(processVideoElement);
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

function processVideoElement(video) {
  if (pillRegistry.has(video)) return;

  const rect = video.getBoundingClientRect();
  if (rect.width >= 150 && rect.height >= 150) {
    createPill(video);
  }
}

function createPill(video) {
  if (pillRegistry.has(video)) return;
  console.log(`${LOG} Creating pill for video`);

  const instance = {
    video: video,
    element: null,
    state: STATE_PILL,
    dragOffset: { x: 0, y: 0 },
    isVisible: false,
    anchorRight: false,
    anchorBottom: false,
    cachedUrl: null,
    cachedData: null,
    menuHoverTimer: null,
  };

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

  if (resizeObserver) resizeObserver.observe(video);
  if (intersectionObserver) intersectionObserver.observe(video);

  schedulePositionUpdate();
}

function destroyPill(video) {
  const instance = pillRegistry.get(video);
  if (!instance) return;

  console.log(`${LOG} Destroying pill`);

  if (resizeObserver) resizeObserver.unobserve(video);
  if (intersectionObserver) intersectionObserver.unobserve(video);
  if (instance.closeHandlers) removeMenuCloseTriggers(instance);

  if (instance.element && instance.element.parentNode) {
    instance.element.parentNode.removeChild(instance.element);
  }

  pillRegistry.delete(video);
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

    const payload = { url: url, format_id: formatId, engine: engineType, page_url: window.location.href };
    if (sanitizedTitle) payload.title = sanitizedTitle;

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
}

function sanitizePageTitle() {
  let raw = "";
  
  // 1. Try to find a prominent h1 title (often the course or video name)
  const h1 = document.querySelector("h1");
  if (h1 && h1.innerText && h1.innerText.trim()) {
    raw = h1.innerText.trim();
  }
  
  // 2. Fallback to document.title
  if (!raw) {
    raw = document.title;
  }

  // 3. Fallback to URL slug if generic
  if (!raw || typeof raw !== "string" || raw.trim().toLowerCase() === "cloud native base camp") {
    const pathParts = window.location.pathname.split("/").filter(Boolean);
    if (pathParts.length > 0) {
      const slug = pathParts[pathParts.length - 1];
      raw = slug.replace(/-/g, " ").replace(/\b\w/g, char => char.toUpperCase());
    }
  }

  if (!raw || typeof raw !== "string") return null;

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

  let clean = raw.replace(/[/\\:*?"<>|]/g, "").trim();
  clean = clean.replace(/\s+/g, " ");
  if (clean.length > 200) clean = clean.substring(0, 200).trim();
  return clean || null;
}

init();
