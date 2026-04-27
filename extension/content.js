const LOG = "[UHDD UI]";

// The Ghost UI State
let uiHost = null;
let shadowRoot = null;
let uiContainer = null;
let floatingBtn = null;
let dropdown = null;

let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let initialLeft = 0;
let initialTop = 0;
let currentLeft = 0; 
let currentTop = 0;  

let observer = null;

// CSS Reset for host (ensures it escapes host stacking contexts)
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

// Start listening for <video> tags
function init() {
  if (uiHost) return;

  if (document.querySelector("video")) {
    injectUI();
  } else {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          if (document.querySelector("video")) {
            observer.disconnect();
            injectUI();
            break;
          }
        }
      }
    });
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  }
}

function injectUI() {
  if (uiHost) return;
  console.log(`${LOG} Video detected, injecting Draggable Hybrid UI`);

  currentLeft = window.innerWidth - 80;
  currentTop = 80;

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
  // JS Absolute Positioning - No CSS variables allowed here for positioning
  uiContainer.style.left = currentLeft + "px";
  uiContainer.style.top = currentTop + "px";
  
  floatingBtn = document.createElement("div");
  floatingBtn.className = "floating-btn";
  floatingBtn.innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
    <div class="status-indicator">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
  `;

  dropdown = document.createElement("div");
  dropdown.className = "dropdown";

  uiContainer.appendChild(floatingBtn);
  uiContainer.appendChild(dropdown);
  shadowRoot.appendChild(uiContainer);
  document.documentElement.appendChild(uiHost);

  setupInteractions();
}

function setupInteractions() {
  floatingBtn.addEventListener("mousedown", onMouseDown);
  
  // EVENT DELEGATION: Listen on container for format-btn clicks
  uiContainer.addEventListener('click', (e) => {
    const btn = e.target.closest('.format-btn');
    if (!btn) return;
    
    // Explicitly use window.location.href as the payload URL
    const url = window.location.href;
    const formatId = btn.getAttribute('data-format-id');
    
    if (!formatId) return;

    // Visual feedback
    btn.classList.add("dispatching");
    const allBtns = uiContainer.querySelectorAll('.format-btn');
    allBtns.forEach(b => b.disabled = true);

    // DUMB UI: Dispatch to Background Script
    chrome.runtime.sendMessage({
      action: "TRIGGER_DOWNLOAD",
      payload: { url: url, format_id: formatId, engine: "ytdlp" }
    }, (response) => {
      if (chrome.runtime.lastError || (response && !response.ok)) {
        console.error(`${LOG} Download trigger failed`);
        btn.querySelector('.quality-label-wrap').innerHTML = '<span style="color:var(--error)">Failed</span>';
        btn.classList.remove("dispatching");
        setTimeout(() => {
          dropdown.classList.remove("open");
        }, 1500);
        return;
      }
      
      dropdown.classList.remove("open");
      const indicator = floatingBtn.querySelector(".status-indicator");
      indicator.classList.add("visible");
      setTimeout(() => {
        indicator.classList.remove("visible");
      }, 2000);
    });
  });

  // Close dropdown when clicking outside
  document.addEventListener("mousedown", (e) => {
    if (dropdown.classList.contains("open")) {
      const path = e.composedPath();
      // Ensure click is outside our shadow DOM entirely
      if (!path.includes(uiHost)) {
        dropdown.classList.remove("open");
      }
    }
  }, { capture: true });
}

function onMouseDown(e) {
  if (e.button !== 0) return; // Only left click
  e.preventDefault();
  
  isDragging = false;
  dragStartX = e.clientX;
  dragStartY = e.clientY;
  initialLeft = currentLeft;
  initialTop = currentTop;

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e) {
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;

  // Use Math.hypot to distinguish drag vs click
  if (!isDragging && Math.hypot(dx, dy) > 5) {
    isDragging = true;
    dropdown.classList.remove("open");
  }

  if (isDragging) {
    currentLeft = initialLeft + dx;
    currentTop = initialTop + dy;
    
    const maxX = window.innerWidth - 48;
    const maxY = window.innerHeight - 48;
    currentLeft = Math.max(0, Math.min(currentLeft, maxX));
    currentTop = Math.max(0, Math.min(currentTop, maxY));

    // Pure JS positioning, CSS variables are STRICTLY forbidden here
    uiContainer.style.left = currentLeft + "px";
    uiContainer.style.top = currentTop + "px";
  }
}

function onMouseUp(e) {
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);

  if (!isDragging) {
    toggleDropdown();
  }
  isDragging = false;
}

function toggleDropdown() {
  if (dropdown.classList.contains("open")) {
    dropdown.classList.remove("open");
  } else {
    openDropdown();
  }
}

function openDropdown() {
  dropdown.classList.add("open");
  dropdown.innerHTML = '<div class="loading-text">Fetching formats...</div>';

  const videoUrl = window.location.href;

  // Dispatch GET_HYBRID_STREAMS to background
  chrome.runtime.sendMessage({ action: "GET_HYBRID_STREAMS", url: videoUrl }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      dropdown.innerHTML = `<div class="loading-text" style="color: var(--error)">Failed to fetch formats</div>`;
      return;
    }
    renderFormats(response.data);
  });
}

function renderFormats(data) {
  if (!data || !data.options || data.options.length === 0) {
    dropdown.innerHTML = '<div class="loading-text">No download options found.</div>';
    return;
  }

  dropdown.innerHTML = `<div class="dropdown-header" title="${data.title || "Download Options"}">${data.title || "Download Options"}</div>`;

  data.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.className = `format-btn ${opt.type === "audio" ? "audio" : "video"}`;
    if (idx === 0) btn.classList.add("recommended");
    
    // We attach the format_id for the Event Delegation listener
    btn.setAttribute('data-format-id', opt.format_id);

    // Icon
    let iconContent = "▶";
    if (opt.type === "audio") iconContent = "♫";
    else if (opt.badge === "4K") iconContent = "4K";
    else if (opt.badge === "QHD") iconContent = "2K";
    else if (opt.badge === "HD" || opt.badge === "HQ") iconContent = "HD";
    else if (opt.badge === "RAW") iconContent = "🎬"; // Used for intercept
    
    let badgeHtml = "";
    if (opt.badge) {
      badgeHtml = `<span class="quality-badge badge-${opt.badge.toLowerCase()}">${opt.badge}</span>`;
    } else if (opt.resolution) {
      // Fallback if background didn't give a badge
      const height = parseInt(opt.resolution.split('x')[1]) || 0;
      let fallbackBadge = 'sd';
      if (height >= 2160) fallbackBadge = '4k';
      else if (height >= 1440) fallbackBadge = 'qhd';
      else if (height >= 1080) fallbackBadge = 'hd';
      else if (height >= 720) fallbackBadge = 'hq';
      if (height >= 720) badgeHtml = `<span class="quality-badge badge-${fallbackBadge}">${fallbackBadge.toUpperCase()}</span>`;
    } else if (opt.type === "audio") {
      badgeHtml = `<span class="quality-badge badge-audio">AUDIO</span>`;
    }

    const ext = opt.ext ? opt.ext.toUpperCase() : "MP4";
    const size = opt.filesize ? (opt.filesize / 1024 / 1024).toFixed(1) + " MB" : "";
    const detailsText = [ext, size, opt.vcodec !== 'none' ? opt.vcodec : opt.acodec].filter(Boolean).join(" • ");

    btn.innerHTML = `
      <span class="quality-icon">${iconContent}</span>
      <div class="quality-label-wrap">
        <span class="quality-label">
          ${opt.label || opt.resolution || 'Audio'} ${badgeHtml}
        </span>
        <span class="format-details">${detailsText}</span>
      </div>
      <span class="quality-arrow">↓</span>
    `;

    dropdown.appendChild(btn);
  });
}

// Start lazy injection process
init();
