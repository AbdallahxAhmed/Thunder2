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

// CSS Reset for host (ensures it escapes host stacking contexts as much as possible)
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

  // Check if a video already exists
  if (document.querySelector("video")) {
    injectUI();
  } else {
    // Wait for a video to be added
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
  console.log(`${LOG} Video detected, injecting Draggable Ghost UI`);

  // Default to top right corner with some padding
  currentLeft = window.innerWidth - 80;
  currentTop = 80;

  uiHost = document.createElement("div");
  uiHost.id = "uhdd-host";
  uiHost.style.cssText = HOST_STYLE;

  shadowRoot = uiHost.attachShadow({ mode: "closed" });

  // Inject CSS inside Shadow Root
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chrome.runtime.getURL("content.css");
  shadowRoot.appendChild(link);

  // Container
  uiContainer = document.createElement("div");
  uiContainer.id = "uhdd-container";
  uiContainer.style.left = currentLeft + "px";
  uiContainer.style.top = currentTop + "px";
  
  // Button
  floatingBtn = document.createElement("div");
  floatingBtn.className = "floating-btn";
  floatingBtn.innerHTML = `
    <svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
    <div class="status-indicator">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
  `;

  // Dropdown
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
  
  // Close dropdown when clicking outside
  document.addEventListener("mousedown", (e) => {
    if (dropdown.classList.contains("open")) {
      const path = e.composedPath();
      if (!path.includes(uiContainer)) {
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

  // Bind to document to prevent event hijacking if cursor leaves button
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e) {
  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;

  // Use Math.hypot to distinguish drag vs click (threshold: 5px)
  if (!isDragging && Math.hypot(dx, dy) > 5) {
    isDragging = true;
    dropdown.classList.remove("open"); // Close dropdown while dragging
  }

  if (isDragging) {
    currentLeft = initialLeft + dx;
    currentTop = initialTop + dy;
    
    // Clamp to viewport bounds to prevent getting lost
    const maxX = window.innerWidth - 48;
    const maxY = window.innerHeight - 48;
    currentLeft = Math.max(0, Math.min(currentLeft, maxX));
    currentTop = Math.max(0, Math.min(currentTop, maxY));

    // DRAGGABLE GHOST: Update positioning strictly via JS style.left and style.top
    uiContainer.style.left = currentLeft + "px";
    uiContainer.style.top = currentTop + "px";
  }
}

function onMouseUp(e) {
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);

  if (!isDragging) {
    // Distance < 5, registered as a click
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

  // DUMB UI ENFORCEMENT: Proxy through background.js via GET_TAB_STREAMS
  chrome.runtime.sendMessage({ action: "GET_TAB_STREAMS", url: videoUrl }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      dropdown.innerHTML = `<div class="loading-text" style="color: var(--uhdd-error)">Failed to fetch formats</div>`;
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

  dropdown.innerHTML = `<div class="dropdown-header">${data.title || "Download Options"}</div>`;

  data.options.forEach(opt => {
    const item = document.createElement("div");
    item.className = "dropdown-item";
    
    // Determine badge
    let badgeHtml = '';
    let badgeClass = 'badge-sd';
    if (opt.resolution) {
      const height = parseInt(opt.resolution.split('x')[1]) || 0;
      if (height >= 2160) badgeClass = 'badge-4k';
      else if (height >= 1080) badgeClass = 'badge-hd';
      
      badgeHtml = `<span class="badge ${badgeClass}">${height}p</span>`;
    } else if (opt.audio_only) {
      badgeHtml = `<span class="badge badge-audio">AUDIO</span>`;
    }

    let ext = opt.ext || "mp4";
    let size = opt.filesize ? (opt.filesize / 1024 / 1024).toFixed(1) + " MB" : "Unknown Size";

    item.innerHTML = `
      <div class="format-info">
        <span class="format-res">${opt.format_note || opt.resolution || 'Audio'}</span>
        <span class="format-details">${ext.toUpperCase()} • ${size} • ${opt.vcodec !== 'none' ? opt.vcodec : opt.acodec}</span>
      </div>
      ${badgeHtml}
    `;

    // CSP COMPLIANCE: No inline onclick attributes. Use addEventListener.
    item.addEventListener("click", () => triggerDownload(opt.format_id, data.url));
    dropdown.appendChild(item);
  });
}

function triggerDownload(formatId, url) {
  console.log(`${LOG} Dispatching download via SW...`);
  dropdown.classList.remove("open");
  
  const payload = {
    url: url || window.location.href,
    engine: "ytdlp",
    format_id: formatId
  };

  // DUMB UI ENFORCEMENT: Strictly send message to background.js
  chrome.runtime.sendMessage({ action: "TRIGGER_DOWNLOAD", payload: payload }, (response) => {
    if (chrome.runtime.lastError || (response && !response.ok)) {
      console.error(`${LOG} Download trigger failed`);
      return;
    }
    
    // Show success indicator
    const indicator = floatingBtn.querySelector(".status-indicator");
    indicator.classList.add("visible");
    setTimeout(() => {
      indicator.classList.remove("visible");
    }, 2000);
  });
}

// Start lazy injection process
init();
