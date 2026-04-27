/**
 * UHDD Content Script — Lazy Injection Rewrite
 * Strictly injects body-level UI ONLY if a video is found in the current frame.
 */

const DAEMON_URL = "http://localhost:8000";
let activeDropdown = null;
let isVideoPresent = false;
let floatRoot = null;
let floatBtn = null;

// SVG Icon
const downloadIcon = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;

document.addEventListener('DOMContentLoaded', startVideoObserver);
startVideoObserver();

function startVideoObserver() {
  if (window.uhddObserverAttached) return;
  if (!document.body) {
    requestAnimationFrame(startVideoObserver);
    return;
  }
  window.uhddObserverAttached = true;

  const observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
        shouldScan = true;
        break;
      }
    }
    if (shouldScan) requestAnimationFrame(scanForVideos);
  });
  
  observer.observe(document.body, { childList: true, subtree: true });
  scanForVideos(); // Initial scan
}

function scanForVideos() {
  const videos = document.querySelectorAll('video');
  const hasVideo = Array.from(videos).some(v => v.offsetWidth > 0 || v.offsetHeight > 0 || v.readyState > 0);
  
  // 1. LAZY INJECTION: Only create the UI if a video is actually found.
  if (hasVideo && !floatRoot) {
    injectUI();
  }

  // 2. Toggle active/inactive states
  if (hasVideo !== isVideoPresent) {
    isVideoPresent = hasVideo;
    if (floatRoot) {
      if (hasVideo) {
        floatRoot.classList.remove('uhdd-inactive');
        floatBtn.title = "Drag to move. Click to download formats.";
      } else {
        floatRoot.classList.add('uhdd-inactive');
        floatBtn.title = "No video detected on this page.";
        closeDropdown();
      }
    }
  }
}

function injectUI() {
  if (document.getElementById('uhdd-float-root')) return;

  // Create Root Container
  floatRoot = document.createElement('div');
  floatRoot.id = 'uhdd-float-root';
  floatRoot.className = 'uhdd-floating-btn-container';
  
  // Default position
  floatRoot.style.top = '20px';
  floatRoot.style.left = (window.innerWidth - 64) + 'px';

  // Create Button
  floatBtn = document.createElement('button');
  floatBtn.className = 'uhdd-floating-btn';
  floatBtn.innerHTML = downloadIcon;
  floatBtn.title = "Download with UHDD";
  
  floatRoot.appendChild(floatBtn);
  document.body.appendChild(floatRoot);

  // ─────────────────────────────────────────────────────────────────────────
  // DRAG & CLICK LOGIC (Strictly bounded to injectUI per user request)
  // ─────────────────────────────────────────────────────────────────────────
  let isDragging = false;
  let startX, startY, initialLeft, initialTop;
  let hasMoved = false;

  const container = document.getElementById('uhdd-float-root');
  const mainBtn = container.querySelector('.uhdd-floating-btn');

  // Restore position using the exact keys
  chrome.storage.local.get(['uhddFloatX', 'uhddFloatY'], (res) => {
    if (res.uhddFloatX && res.uhddFloatY) {
      container.style.right = 'auto';
      container.style.bottom = 'auto';
      container.style.left = res.uhddFloatX;
      container.style.top = res.uhddFloatY;
    }
  });

  mainBtn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    
    // Get actual current pixel position
    const rect = container.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    
    // Crucial: Break the CSS 'right' and 'bottom' anchors
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    
    // Visual feedback
    container.style.cursor = 'grabbing';
    e.preventDefault(); // Prevent text selection
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    // If moved more than 5px, it's a drag
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      hasMoved = true;
    }
    
    container.style.left = `${initialLeft + dx}px`;
    container.style.top = `${initialTop + dy}px`;
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    container.style.cursor = 'grab';
    
    if (!hasMoved) {
      // IT WAS A CLICK - OPEN THE MENU
      if (isVideoPresent) {
        toggleDropdown();
        if (activeDropdown && !formatsLoaded) {
          fetchFormatsFromBackground(); 
        }
      }
    } else {
      // IT WAS A DRAG - SAVE POSITION
      chrome.storage.local.set({ 
        uhddFloatX: container.style.left, 
        uhddFloatY: container.style.top 
      });
    }
  });

  // Close dropdown if clicking outside
  document.addEventListener('mousedown', (e) => {
    if (activeDropdown && !container.contains(e.target)) {
      closeDropdown();
    }
  });
}

// ─── Dropdown UI & Logic ──────────────────────────────────────────────────

let formatsLoaded = false;

function toggleDropdown() {
  if (activeDropdown) {
    closeDropdown();
    return;
  }

  const dropdown = document.createElement('div');
  dropdown.className = 'uhdd-dropdown';
  
  // Aggressive scroll event trap
  ['wheel', 'mousewheel', 'DOMMouseScroll', 'touchmove'].forEach(evt => {
    dropdown.addEventListener(evt, (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    }, { passive: true });
  });

  // Block clicks inside dropdown from propagating
  dropdown.addEventListener('mousedown', e => e.stopPropagation());
  dropdown.addEventListener('click', e => e.stopPropagation());

  dropdown.innerHTML = `
    <div class="uhdd-state-container">
      <div class="uhdd-spinner"></div>
      <div>Finding formats...</div>
    </div>
  `;
  
  floatRoot.appendChild(dropdown);
  dropdown.offsetHeight; // Force reflow
  dropdown.classList.add('uhdd-visible');
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
    <div class="uhdd-state-container">
      <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
      <div class="uhdd-error-text">${message}</div>
    </div>
  `;
}

function renderSuccessState() {
  if (!activeDropdown) return;
  activeDropdown.innerHTML = `
    <div class="uhdd-state-container">
      <div class="uhdd-success-icon">✓</div>
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
    item.className = 'uhdd-dropdown-item';
    if (idx === 0) item.classList.add('uhdd-recommended');

    const left = document.createElement('div');
    left.className = 'uhdd-item-left';
    
    const icon = document.createElement('div');
    icon.className = 'uhdd-item-icon';
    icon.textContent = opt.type === "audio" ? "♫" : "▶";

    const details = document.createElement('div');
    details.className = 'uhdd-item-details';
    
    const title = document.createElement('div');
    title.className = 'uhdd-item-title';
    title.textContent = opt.label;
    
    const meta = document.createElement('div');
    meta.className = 'uhdd-item-meta';
    meta.textContent = [opt.filesize_str, opt.vcodec, opt.acodec].filter(Boolean).join(' • ');

    details.appendChild(title);
    details.appendChild(meta);
    left.appendChild(icon);
    left.appendChild(details);

    const right = document.createElement('div');
    right.className = 'uhdd-item-right';
    
    if (opt.badge) {
      const badge = document.createElement('span');
      badge.className = `uhdd-badge uhdd-badge-${opt.badge.toLowerCase()}`;
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
    activeDropdown.classList.remove('uhdd-visible');
    setTimeout(() => {
      if (activeDropdown) activeDropdown.remove();
      activeDropdown = null;
    }, 200);
  }
}

async function dispatchDownload(url, format_id) {
  if (activeDropdown) {
    activeDropdown.innerHTML = `
      <div class="uhdd-state-container">
        <div class="uhdd-spinner"></div>
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
