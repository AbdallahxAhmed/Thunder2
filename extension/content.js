/**
 * UHDD Content Script — Shadow DOM Floating UI
 * Strictly injects body-level UI in the top frame only.
 */

if (window !== window.top) {
  // Prevent iframe spam
  throw new Error("UHDD content script aborting in iframe.");
}

const DAEMON_URL = "http://localhost:8000";
let floatBtn = null;
let activeDropdown = null;
let formatsLoaded = false;
let shadowRoot = null;

const downloadIcon = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
</svg>
`;

document.addEventListener('DOMContentLoaded', injectShadowUI);
if (document.readyState === 'interactive' || document.readyState === 'complete') {
  injectShadowUI();
}

function injectShadowUI() {
  if (document.getElementById('uhdd-host')) return;
  if (!document.body) {
    requestAnimationFrame(injectShadowUI);
    return;
  }

  const host = document.createElement('div');
  host.id = 'uhdd-host';
  // Host covers the entire viewport but doesn't block clicks
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
  document.body.appendChild(host);

  shadowRoot = host.attachShadow({ mode: 'closed' });

  // 1. Inject CSS safely via web_accessible_resources
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('content.css');
  shadowRoot.appendChild(link);

  // 2. Create Floating Button
  floatBtn = document.createElement('button');
  floatBtn.className = 'floating-btn';
  floatBtn.innerHTML = downloadIcon;
  floatBtn.title = "Drag to move. Click to download formats.";
  
  // Default position
  floatBtn.style.position = 'absolute';
  floatBtn.style.top = '20px';
  floatBtn.style.left = (window.innerWidth - 64) + 'px';

  shadowRoot.appendChild(floatBtn);

  // 3. Drag and Click Logic
  let isDragging = false;
  let startX, startY;
  let initialLeft, initialTop;

  // Restore position
  chrome.storage.local.get(['uhddFloatX', 'uhddFloatY'], (res) => {
    if (res.uhddFloatX && res.uhddFloatY) {
      floatBtn.style.left = res.uhddFloatX;
      floatBtn.style.top = res.uhddFloatY;
    }
  });

  floatBtn.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    initialLeft = parseFloat(floatBtn.style.left) || (window.innerWidth - 64);
    initialTop = parseFloat(floatBtn.style.top) || 20;

    e.preventDefault();
    e.stopPropagation();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    floatBtn.style.left = `${initialLeft + dx}px`;
    floatBtn.style.top = `${initialTop + dy}px`;
  });

  document.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    isDragging = false;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dist = Math.hypot(dx, dy);

    if (dist < 5) {
      // CLICK
      toggleDropdown();
      if (activeDropdown && !formatsLoaded) {
        fetchFormatsFromBackground();
      }
    } else {
      // DRAG - Save new position
      chrome.storage.local.set({ 
        uhddFloatX: floatBtn.style.left, 
        uhddFloatY: floatBtn.style.top 
      });
    }
  });

  // 4. Click outside to close
  document.addEventListener('mousedown', (e) => {
    if (activeDropdown) {
      // event.composedPath() works across shadow boundaries
      const path = e.composedPath();
      if (!path.includes(activeDropdown) && !path.includes(floatBtn)) {
        closeDropdown();
      }
    }
  });
}

function toggleDropdown() {
  if (activeDropdown) {
    closeDropdown();
    return;
  }

  const dropdown = document.createElement('div');
  dropdown.className = 'dropdown';
  
  // Position dropdown relative to the button
  const btnLeft = parseFloat(floatBtn.style.left) || 0;
  const btnTop = parseFloat(floatBtn.style.top) || 0;
  
  // Ensure the dropdown doesn't go off-screen
  let dropLeft = btnLeft - 276; // Default to left-align (320px width - 44px btn)
  if (dropLeft < 0) dropLeft = btnLeft; // Snap to right-align if too far left
  
  dropdown.style.left = `${dropLeft}px`;
  dropdown.style.top = `${btnTop + 54}px`;
  
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
      badge.className = \`badge badge-\${opt.badge.toLowerCase()}\`;
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
    activeDropdown.innerHTML = \`
      <div class="state-container">
        <div class="spinner"></div>
        <div>Sending to daemon...</div>
      </div>
    \`;
  }

  try {
    const response = await fetch(\`\${DAEMON_URL}/api/download\`, {
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
