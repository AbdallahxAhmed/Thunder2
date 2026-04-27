/**
 * UHDD Content Script — Body-Level Draggable Floating Download Button
 * 
 * Injects a floating download button directly into document.body.
 * Draggable, remembers position, and intelligently detects <video> presence.
 */

const DAEMON_URL = "http://localhost:8000";
let currentUrl = window.location.href;
let activeDropdown = null;
let floatingContainer = null;
let isVideoPresent = false;

// SVG Icon for the floating button
const downloadIcon = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;

// ─── Initialization ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', initUI);
initUI(); // Run immediately in case DOMContentLoaded already fired

function initUI() {
  if (document.getElementById('uhdd-floating-ui')) return;
  if (!document.body) {
    // Retry if body isn't ready
    requestAnimationFrame(initUI);
    return;
  }

  floatingContainer = document.createElement('div');
  floatingContainer.id = 'uhdd-floating-ui';
  floatingContainer.className = 'uhdd-floating-btn-container uhdd-inactive';

  const btn = document.createElement('button');
  btn.className = 'uhdd-floating-btn';
  btn.innerHTML = downloadIcon;
  btn.title = "Download with UHDD";

  floatingContainer.appendChild(btn);
  document.body.appendChild(floatingContainer);

  setupDraggable(floatingContainer, btn);

  scanForVideos();

  // Watch for DOM changes (new videos added dynamically)
  const observer = new MutationObserver((mutations) => {
    // Check for SPA URL changes
    if (currentUrl !== window.location.href) {
      currentUrl = window.location.href;
      closeDropdown(); 
      scanForVideos();
    } else {
      let hasNewNodes = false;
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0) {
          hasNewNodes = true;
          break;
        }
      }
      if (hasNewNodes) {
        requestAnimationFrame(scanForVideos);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Video Detection ──────────────────────────────────────────────────────

function scanForVideos() {
  const videos = document.querySelectorAll('video');
  // Simple heuristic: is there a video that is somewhat visible?
  const hasVideo = Array.from(videos).some(v => v.offsetWidth > 0 || v.offsetHeight > 0 || v.readyState > 0);
  
  if (hasVideo !== isVideoPresent) {
    isVideoPresent = hasVideo;
    if (floatingContainer) {
      if (hasVideo) {
        floatingContainer.classList.remove('uhdd-inactive');
        floatingContainer.title = "Drag to move. Click to download formats.";
      } else {
        floatingContainer.classList.add('uhdd-inactive');
        floatingContainer.title = "No video detected on this page.";
        closeDropdown();
      }
    }
  }
}

// ─── Draggable Logic ──────────────────────────────────────────────────────

function setupDraggable(container, btn) {
  let isDragging = false;
  let startX, startY;
  let initialLeft, initialTop;
  let hasMoved = false;

  // Restore position
  chrome.storage.local.get(['uhddBtnPos'], (result) => {
    if (result.uhddBtnPos) {
      container.style.right = 'auto'; // override default right:20px
      container.style.left = result.uhddBtnPos.left;
      container.style.top = result.uhddBtnPos.top;
    }
  });

  const onMouseDown = (e) => {
    if (e.button !== 0 || e.target.closest('.uhdd-dropdown')) return;
    
    isDragging = true;
    hasMoved = false;
    startX = e.clientX;
    startY = e.clientY;
    
    const rect = container.getBoundingClientRect();
    initialLeft = rect.left;
    initialTop = rect.top;
    
    container.style.right = 'auto';
    container.style.left = initialLeft + 'px';
    container.style.top = initialTop + 'px';

    e.preventDefault(); // prevent text selection
    e.stopPropagation(); // prevent video play/pause toggles underneath
  };

  const onMouseMove = (e) => {
    if (!isDragging) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      hasMoved = true;
    }

    if (hasMoved) {
      // Boundaries
      let newLeft = initialLeft + dx;
      let newTop = initialTop + dy;
      
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth - container.offsetWidth));
      newTop = Math.max(0, Math.min(newTop, window.innerHeight - btn.offsetHeight));
      
      container.style.left = newLeft + 'px';
      container.style.top = newTop + 'px';
    }
  };

  const onMouseUp = (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    if (!hasMoved && isVideoPresent && e.target.closest('.uhdd-floating-btn')) {
      toggleDropdown(btn, container);
    } else if (hasMoved) {
      chrome.storage.local.set({
        uhddBtnPos: {
          left: container.style.left,
          top: container.style.top
        }
      });
    }
  };

  container.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Block clicks from hitting underlying video when releasing drag
  container.addEventListener('click', (e) => {
    e.stopPropagation();
  });
}

// ─── Dropdown UI & Logic ──────────────────────────────────────────────────

function toggleDropdown(btn, container) {
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

  // Block clicks inside dropdown from propagating to document
  dropdown.addEventListener('mousedown', e => e.stopPropagation());
  dropdown.addEventListener('click', e => e.stopPropagation());

  dropdown.innerHTML = `
    <div class="uhdd-state-container">
      <div class="uhdd-spinner"></div>
      <div>Finding formats...</div>
    </div>
  `;
  
  container.appendChild(dropdown);
  dropdown.offsetHeight; // Force reflow
  dropdown.classList.add('uhdd-visible');
  activeDropdown = dropdown;

  chrome.runtime.sendMessage({ type: "getFormats" }, (response) => {
    if (chrome.runtime.lastError) {
      renderErrorState("Backend offline — start UHDD daemon.");
      return;
    }
    
    if (!response || !response.ok) {
      const msg = response?.error?.includes("422")
        ? "Unsupported URL or no formats available."
        : "Backend offline — start UHDD daemon.";
      renderErrorState(msg);
      return;
    }

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
  
  setTimeout(() => {
    if (activeDropdown) {
      activeDropdown.classList.remove('uhdd-visible');
      setTimeout(closeDropdown, 200);
    }
  }, 2000);
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
      dispatchDownload(currentUrl, opt.format_id);
    });

    activeDropdown.appendChild(item);
  });
}

function closeDropdown() {
  if (activeDropdown) {
    activeDropdown.remove();
    activeDropdown = null;
  }
}

// Close dropdown when clicking outside
document.addEventListener('mousedown', (e) => {
  if (activeDropdown && !floatingContainer.contains(e.target)) {
    activeDropdown.classList.remove('uhdd-visible');
    setTimeout(closeDropdown, 200);
  }
});

// ─── Download Dispatch ────────────────────────────────────────────────────

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
