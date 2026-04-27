/**
 * UHDD Content Script — Ghost Overlay Tracking System
 * Strictly injects body-level UI in the top frame only and tracks the video element.
 */



const DAEMON_URL = "http://localhost:8000";
let floatBtn = null;
let activeDropdown = null;
let formatsLoaded = false;
let shadowRoot = null;
let targetVideo = null;
let host = null;

let isTracking = false;
let rafId = null;

const downloadIcon = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;



function initializeSystem() {
  if (document.getElementById('uhdd-host')) return;
  if (!document.documentElement) {
    requestAnimationFrame(initializeSystem);
    return;
  }

  // 1. Root-Level Host Injection
  host = document.createElement('uhdd-host');
  host.style.cssText = `
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    z-index: 2147483647 !important;
    pointer-events: none !important;
    background: transparent !important;
    border: none !important;
    margin: 0 !important;
    padding: 0 !important;
  `;
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);

  shadowRoot = host.attachShadow({ mode: 'open' });

  // Inject CSS safely via web_accessible_resources
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content.css');
  shadowRoot.appendChild(link);

  // Create Floating Button (Hidden by default)
  floatBtn = document.createElement('button');
  floatBtn.className = 'floating-btn';
  floatBtn.innerHTML = downloadIcon;
  floatBtn.title = "Download with UHDD";
  floatBtn.style.position = 'absolute';
  floatBtn.style.display = 'none';
  floatBtn.style.pointerEvents = 'auto'; // allow clicks
  floatBtn.style.top = '0';
  floatBtn.style.left = '0';
  
  shadowRoot.appendChild(floatBtn);

  // Click logic (No dragging or Math.hypot)
  floatBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleDropdown();
    if (activeDropdown && !formatsLoaded) {
      fetchFormatsFromBackground();
    }
  });

  // Click outside to close dropdown
  document.addEventListener('mousedown', (e) => {
    if (activeDropdown) {
      const path = e.composedPath();
      if (!path.includes(activeDropdown) && !path.includes(floatBtn)) {
        closeDropdown();
      }
    }
  });

}

// ─── DYNAMIC DOM HANDLING & MUTATION OBSERVER ──────────────────────────────

function startVideoObserver() {
  scanForVideos();

  // Watch for dynamic video element creation/destruction (e.g., YouTube ad breaks)
  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    // If the tracked video was removed from the DOM, untrack and scan again
    if (targetVideo && !document.contains(targetVideo)) {
      untrackVideo();
      shouldScan = true;
    }
    if (shouldScan && !isTracking) {
      scanForVideos();
    }
  });
  observer.observe(document.body, { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['style', 'class', 'hidden']
  });
}

function scanForVideos() {
  const videos = document.querySelectorAll('video');
  let bestVideo = null;
  let maxArea = 0;
  
  for (const v of videos) {
    const rect = v.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > maxArea && area > 10000) { // Ignore tiny 1x1 tracking videos
      maxArea = area;
      bestVideo = v;
    } else if (!v._uhddWatched) {
      v._uhddWatched = true;
      const waitObserver = new ResizeObserver(() => {
        const r = v.getBoundingClientRect();
        if (r.width * r.height > 10000 && !isTracking) {
          waitObserver.disconnect();
          scanForVideos();
        }
      });
      waitObserver.observe(v);
    }
  }

  if (bestVideo && bestVideo !== targetVideo) {
    trackVideo(bestVideo);
  }
}

// ─── GHOST OVERLAY TRACKING SYSTEM ───────────────────────────────────────

let resizeObserver = null;
let intersectionObserver = null;

function trackVideo(videoElement) {
  if (!host) initializeSystem();
  if (isTracking) untrackVideo();
  targetVideo = videoElement;
  isTracking = true;

  // 1. ResizeObserver: Track video dimension changes
  resizeObserver = new ResizeObserver(() => {
    schedulePositionUpdate();
  });
  resizeObserver.observe(targetVideo);

  // 2. IntersectionObserver: Hide button when video is out of viewport
  intersectionObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        applyPositionUpdate();
        floatBtn.style.display = 'flex';
        schedulePositionUpdate();
      } else {
        floatBtn.style.display = 'none';
        closeDropdown(); // Close if open
      }
    }
  }, { threshold: 0.1 });
  intersectionObserver.observe(targetVideo);

  // 3. Scroll & Resize sync
  window.addEventListener('scroll', schedulePositionUpdate, true); // capture phase
  window.addEventListener('resize', schedulePositionUpdate);
  
  schedulePositionUpdate();
}

function untrackVideo() {
  isTracking = false;
  targetVideo = null;
  formatsLoaded = false;
  floatBtn.style.display = 'none';
  closeDropdown();
  
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
  
  window.removeEventListener('scroll', schedulePositionUpdate, true);
  window.removeEventListener('resize', schedulePositionUpdate);
  
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

// ─── ANTI-JANK THROTTLED POSITIONING ─────────────────────────────────────

let isUpdateScheduled = false;

function schedulePositionUpdate() {
  if (!isTracking || !targetVideo || isUpdateScheduled) return;
  isUpdateScheduled = true;
  rafId = requestAnimationFrame(applyPositionUpdate);
}

function applyPositionUpdate() {
  isUpdateScheduled = false;
  if (!targetVideo || !host) return;

  const rect = targetVideo.getBoundingClientRect();
  
  // Anchor to top-right of the video with 16px padding
  let leftPos = rect.right - 60;
  if (leftPos < 0) leftPos = rect.left + 16;
  let topPos = rect.top + 16;
  
  // Apply hardware-accelerated transform via CSS vars to avoid :active layout thrashing
  host.style.setProperty('--btn-x', `${leftPos}px`);
  host.style.setProperty('--btn-y', `${topPos}px`);

  // Update dropdown position if active
  if (activeDropdown) {
    let dropLeft = leftPos - 276;
    if (dropLeft < 0) dropLeft = leftPos;
    // We update top/left for dropdown since its CSS has a transform transition
    activeDropdown.style.left = `${dropLeft}px`;
    activeDropdown.style.top = `${topPos + 54}px`;
  }
}

// ─── Dropdown UI & Logic ──────────────────────────────────────────────────

function toggleDropdown() {
  if (activeDropdown) {
    closeDropdown();
    return;
  }

  const dropdown = document.createElement('div');
  dropdown.className = 'dropdown';
  
  // Initial position calculation
  const rect = targetVideo.getBoundingClientRect();
  let leftPos = rect.right - 60;
  if (leftPos < 0) leftPos = rect.left + 16;
  let topPos = rect.top + 16;
  
  let dropLeft = leftPos - 276;
  if (dropLeft < 0) dropLeft = leftPos;
  
  dropdown.style.left = `${dropLeft}px`;
  dropdown.style.top = `${topPos + 54}px`;
  
  // Aggressive scroll event trap
  ['wheel', 'mousewheel', 'DOMMouseScroll', 'touchmove'].forEach(evt => {
    dropdown.addEventListener(evt, (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, { passive: true });
  });

  dropdown.addEventListener('mousedown', e => e.stopPropagation());
  dropdown.addEventListener('click', e => e.stopPropagation());

  dropdown.innerHTML = `
    <div class="state-container">
      <div class="spinner"></div>
      <div>Finding formats...</div>
    </div>
  `;
  
  shadowRoot.appendChild(dropdown);
  dropdown.offsetHeight; // Force reflow
  dropdown.classList.add('visible');
  activeDropdown = dropdown;
}

function fetchFormatsFromBackground() {
  chrome.runtime.sendMessage({ type: "getFormats" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      const msg = response?.error?.includes("422")
        ? "Unsupported URL or no formats available."
        : "Backend offline — start UHDD daemon.";
      renderErrorState(msg);
      return;
    }
    formatsLoaded = true;
    renderFormatOptions(response.data);
  });
}

function renderErrorState(message) {
  if (!activeDropdown) return;
  activeDropdown.innerHTML = `
    <div class="state-container">
      <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
      <div class="error-text">${message}</div>
    </div>
  `;
}

function renderSuccessState() {
  if (!activeDropdown) return;
  activeDropdown.innerHTML = `
    <div class="state-container">
      <div class="success-icon">✓</div>
      <div>Download Queued!</div>
    </div>
  `;
  setTimeout(closeDropdown, 2000);
}

function renderFormatOptions(data) {
  if (!activeDropdown) return;
  if (!data.options || data.options.length === 0) {
    renderErrorState("No formats available.");
    return;
  }

  activeDropdown.innerHTML = '';

  data.options.forEach((opt, idx) => {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    if (idx === 0) item.classList.add('recommended');

    const left = document.createElement('div');
    left.className = 'item-left';
    
    const icon = document.createElement('div');
    icon.className = 'item-icon';
    icon.textContent = opt.type === "audio" ? "♫" : "▶";

    const details = document.createElement('div');
    details.className = 'item-details';
    
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = opt.label;
    
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = [opt.filesize_str, opt.vcodec, opt.acodec].filter(Boolean).join(' • ');

    details.appendChild(title);
    details.appendChild(meta);
    left.appendChild(icon);
    left.appendChild(details);

    const right = document.createElement('div');
    right.className = 'item-right';
    
    if (opt.badge) {
      const badge = document.createElement('span');
      badge.className = `badge badge-${opt.badge.toLowerCase()}`;
      badge.textContent = opt.badge;
      right.appendChild(badge);
    }

    item.appendChild(left);
    item.appendChild(right);

    item.addEventListener('click', (e) => {
      e.stopPropagation();
      dispatchDownload(window.location.href, opt.format_id);
    });

    activeDropdown.appendChild(item);
  });
}

function closeDropdown() {
  if (activeDropdown) {
    activeDropdown.classList.remove('visible');
    setTimeout(() => {
      if (activeDropdown) activeDropdown.remove();
      activeDropdown = null;
    }, 200);
  }
}

async function dispatchDownload(url, format_id) {
  if (activeDropdown) {
    activeDropdown.innerHTML = `
      <div class="state-container">
        <div class="spinner"></div>
        <div>Sending to daemon...</div>
      </div>
    `;
  }

  try {
    const response = await fetch(`${DAEMON_URL}/api/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, engine: "ytdlp", format_id }),
    });

    if (response.ok) {
      renderSuccessState();
    } else {
      renderErrorState("Failed to queue download.");
    }
  } catch (err) {
    renderErrorState("Backend offline — start UHDD daemon.");
  }
}

// Start Video Discovery (Silent Lazy Injection)
startVideoObserver();
