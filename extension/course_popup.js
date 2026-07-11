/**
 * Thunder Extension Popup — Redesigned
 * Health check, WebSocket status, Select All, Pause/Resume/Cancel, Settings
 */

const API_BASE = 'http://localhost:8000';
const WS_URL = 'ws://localhost:8000/api/ws/events';

// ── Toast Notifications ───────────────────────────────────────────────────
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  t.className = `toast badge-${type}`;
  setTimeout(() => t.style.display = 'none', 3000);
}

// ── Connection Status ─────────────────────────────────────────────────────
let isConnected = false;
let harCustomDirs = {};
let yanfaaCustomDirs = {};

async function checkConnection() {
  const dot = document.getElementById('status-dot');
  try {
    const resp = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      dot.classList.add('connected');
      dot.title = 'Backend connected';
      isConnected = true;
    } else {
      throw new Error();
    }
  } catch {
    dot.classList.remove('connected');
    dot.title = 'Backend offline — start Thunder first';
    isConnected = false;
  }
}

// Check connection immediately on popup open
checkConnection().then(() => {
  if (isConnected) loadSettings();
});

// ── Tab Switching ─────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    
    btn.classList.add('active');
    const paneId = `pane-${btn.dataset.tab}`;
    document.getElementById(paneId).classList.add('active');

    if (btn.dataset.tab === 'status') {
      connectWebSocket();
      pollJobs(); // initial fetch
    } else {
      disconnectWebSocket();
    }
    
    if (btn.dataset.tab === 'settings') {
      loadSettings();
    }
  };
});

// ── API Requests Helper ───────────────────────────────────────────────────
async function request(path, method = 'GET', body = null) {
  const token = await new Promise(resolve => {
    chrome.storage.local.get("thunder_api_token", res => resolve(res ? res.thunder_api_token : ""));
  });
  const headers = { 'Content-Type': 'application/json' };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${API_BASE}${path}`, opts);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ message: resp.statusText }));
    throw new Error(err.message || `HTTP ${resp.status}`);
  }
  return resp.json();
}

// ── Select All / Deselect All ─────────────────────────────────────────────
function setupSelectAll(btnId, checkboxClass) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.onclick = () => {
    const boxes = document.querySelectorAll(`.${checkboxClass}`);
    const allChecked = Array.from(boxes).every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    btn.textContent = allChecked ? 'Select All' : 'Deselect All';
  };
}

// ── Helpers to query completed downloads ──────────────────────────────────
function cleanTitleForComparison(title) {
  if (!title) return "";
  return title.toLowerCase()
    .replace(/\b\d+:\d+\b/g, "")
    .replace(/\b\d+\s*(m|min|s|sec)\b/g, "")
    .replace(/[✔▶►●○•■□▪▫#|–\-]/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

async function getCompletedJobs() {
  try {
    const res = await request('/api/course/jobs');
    return (res.jobs || []).filter(j => j.status === 'completed');
  } catch {
    return [];
  }
}

function isCompletedLoose(nameOrUrl, completedJobs) {
  if (!nameOrUrl) return false;
  const val = nameOrUrl.toLowerCase();
  const cleanTarget = cleanTitleForComparison(nameOrUrl);
  
  return completedJobs.some(j => {
    if (j.url && j.url.toLowerCase() === val) return true;
    if (j.title && j.title.toLowerCase() === val) return true;
    if (j.title) {
      const cleanComp = cleanTitleForComparison(j.title);
      if (cleanComp && cleanTarget && (cleanTarget.includes(cleanComp) || cleanComp.includes(cleanTarget))) {
        return true;
      }
    }
    return false;
  });
}

// ── HAR Tab Logic ─────────────────────────────────────────────────────────
let extractedUrls = [];
let extractedNames = [];

document.getElementById('btn-scan-har').onclick = async () => {
  const dir = document.getElementById('har-path').value.trim() || '.';
  try {
    const res = await request(`/api/course/har/scan?directory=${encodeURIComponent(dir)}`, 'POST');
    if (res.files && res.files.length > 0) {
      document.getElementById('har-path').value = res.files[0].path;
      showToast(`Found ${res.files.length} HAR files! First selected.`, 'success');
    } else {
      showToast("No HAR files found in directory.", 'warning');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

document.getElementById('btn-extract-har').onclick = async () => {
  const path = document.getElementById('har-path').value.trim();
  if (!path) return showToast("Provide HAR path first.", 'warning');

  try {
    showToast("Extracting...", 'info');
    const res = await request('/api/course/har/extract', 'POST', { har_path: path });
    extractedUrls = res.urls || [];
    extractedNames = res.names || [];
    harCustomDirs = {}; // Reset custom folders

    if (extractedUrls.length === 0) {
      showToast("No video URLs found in HAR.", 'warning');
      document.getElementById('har-lessons-area').style.display = 'none';
      return;
    }

    const cleanName = path.replace(/\\/g, '/').split('/').pop().replace('.har', '').replace('.json', '');
    document.getElementById('course-name').value = cleanName;

    // Check which ones are already completed
    const completedJobs = await getCompletedJobs();

    const list = document.getElementById('har-checkbox-list');
    list.innerHTML = extractedNames.map((name, i) => {
      const url = extractedUrls[i] || '';
      const isDownloaded = isCompletedLoose(url, completedJobs) || isCompletedLoose(name, completedJobs);
      const checkedAttr = isDownloaded ? '' : 'checked';
      const labelStyle = isDownloaded ? 'style="color: var(--success); font-weight: 500;"' : '';
      const suffix = isDownloaded ? ' <span style="font-size: 0.65rem; opacity: 0.7;">(✓ Downloaded)</span>' : '';
      
      return `
        <li>
          <label class="checkbox-wrap">
            <input type="checkbox" class="har-cb" data-idx="${i}" ${checkedAttr}>
            <span ${labelStyle}>${name}${suffix}</span>
          </label>
        </li>
      `;
    }).join('');

    document.getElementById('har-lessons-area').style.display = 'block';
    setupSelectAll('har-select-all', 'har-cb');
    showToast(`Found ${extractedUrls.length} videos!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

document.getElementById('btn-browse-har-folder').onclick = async (e) => {
  e.preventDefault();
  const checked = document.querySelectorAll('.har-cb:checked');
  if (checked.length === 0) return showToast("Select at least one lesson first.", 'warning');

  try {
    showToast("Opening folder browser...", 'info');
    const res = await request('/api/settings/browse-folder', 'POST');
    if (res.path) {
      const selectedIndices = Array.from(checked).map(cb => parseInt(cb.dataset.idx));
      selectedIndices.forEach(idx => {
        harCustomDirs[idx] = res.path;
      });
      showToast("Custom folder applied!", 'success');
      
      const folderName = res.path.split(/[\\/]/).pop();
      checked.forEach(cb => {
        const label = cb.nextElementSibling;
        const originalText = label.innerHTML.split(' <span')[0].split(' <font')[0].split(' (📁')[0];
        const suffix = label.innerHTML.includes('(✓ Downloaded)') ? ' <span style="font-size: 0.65rem; opacity: 0.7;">(✓ Downloaded)</span>' : '';
        label.innerHTML = `${originalText} <font color="var(--text-accent)" style="font-size: 0.75rem;">(📁 ${folderName})</font>${suffix}`;
      });
    }
  } catch (err) {
    showToast("Could not open folder dialog. Make sure desktop app is active.", 'error');
  }
};

document.getElementById('btn-download-har').onclick = async () => {
  const checked = document.querySelectorAll('.har-cb:checked');
  if (checked.length === 0) return showToast("Select at least one lesson.", 'warning');

  const selectedIndices = Array.from(checked).map(cb => parseInt(cb.dataset.idx));
  const courseName = document.getElementById('course-name').value.trim() || 'har-course';
  const defaultDir = document.getElementById('setting-download-dir').value.trim() || 'downloads';

  showDownloadConfirmModal(courseName, defaultDir, async (result) => {
    const payload = {
      har_path: document.getElementById('har-path').value.trim(),
      course_name: result.title || courseName,
      auto_download: result.autoStart,
      use_scheduler: document.getElementById('use-scheduler-har').checked,
      video_indices: selectedIndices,
      download_dirs: {}
    };

    selectedIndices.forEach(idx => {
      payload.download_dirs[idx] = result.downloadDir;
    });

    try {
      const res = await request('/api/course/har/download', 'POST', payload);
      showToast(`Queued ${res.job_ids.length} downloads!`, 'success');
      document.querySelector('[data-tab="status"]').click();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

document.getElementById('btn-complete-har').onclick = async () => {
  const checked = document.querySelectorAll('.har-cb:checked');
  if (checked.length === 0) return showToast("Select at least one lesson.", 'warning');

  showToast("Marking as completed...", 'info');
  try {
    for (const cb of checked) {
      const idx = parseInt(cb.dataset.idx);
      const name = extractedNames[idx];
      await request('/api/course/jobs/manual-complete', 'POST', { title: name });
    }
    showToast(`Marked ${checked.length} lessons completed!`, 'success');
    // Refresh the list view to show them as completed
    document.getElementById('btn-extract-har').click();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ── Yanfaa Tab Logic ──────────────────────────────────────────────────────
let yanfaaVideos = [];
let yanfaaSlug = '';

document.getElementById('btn-fetch-yanfaa').onclick = async () => {
  let input = document.getElementById('yanfaa-slug').value.trim();
  if (!input) return showToast("Enter course slug/URL.", 'warning');

  const matches = input.match(/single\/([^/?#]+)/);
  if (matches) input = matches[1];
  yanfaaSlug = input;

  try {
    showToast("Fetching...", 'info');
    const res = await request(`/api/yanfaa/course?course_slug=${encodeURIComponent(yanfaaSlug)}`, 'POST');
    yanfaaVideos = res.videos || [];
    yanfaaCustomDirs = {}; // Reset custom folders

    // Check which ones are already completed
    const completedSet = await getCompletedJobSet();

    const list = document.getElementById('yanfaa-checkbox-list');
    list.innerHTML = yanfaaVideos.map((v, i) => {
      const isDownloaded = completedSet.has(v.title.toLowerCase());
      const checkedAttr = isDownloaded ? '' : 'checked';
      const labelStyle = isDownloaded ? 'style="color: var(--success); font-weight: 500;"' : '';
      const suffix = isDownloaded ? ' <span style="font-size: 0.65rem; opacity: 0.7;">(✓ Downloaded)</span>' : '';
      
      return `
        <li>
          <label class="checkbox-wrap">
            <input type="checkbox" class="yanfaa-cb" data-idx="${i}" ${checkedAttr}>
            <span ${labelStyle}>${v.title}${suffix}</span>
          </label>
        </li>
      `;
    }).join('');

    document.getElementById('yanfaa-lessons-area').style.display = 'block';
    setupSelectAll('yanfaa-select-all', 'yanfaa-cb');
    showToast(`Found ${yanfaaVideos.length} videos!`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

document.getElementById('btn-browse-yanfaa-folder').onclick = async (e) => {
  e.preventDefault();
  const checked = document.querySelectorAll('.yanfaa-cb:checked');
  if (checked.length === 0) return showToast("Select at least one video first.", 'warning');

  try {
    showToast("Opening folder browser...", 'info');
    const res = await request('/api/settings/browse-folder', 'POST');
    if (res.path) {
      const selectedIndices = Array.from(checked).map(cb => parseInt(cb.dataset.idx));
      selectedIndices.forEach(idx => {
        yanfaaCustomDirs[idx] = res.path;
      });
      showToast("Custom folder applied!", 'success');
      
      const folderName = res.path.split(/[\\/]/).pop();
      checked.forEach(cb => {
        const label = cb.nextElementSibling;
        const originalText = label.innerHTML.split(' <span')[0].split(' <font')[0].split(' (📁')[0];
        const suffix = label.innerHTML.includes('(✓ Downloaded)') ? ' <span style="font-size: 0.65rem; opacity: 0.7;">(✓ Downloaded)</span>' : '';
        label.innerHTML = `${originalText} <font color="var(--text-accent)" style="font-size: 0.75rem;">(📁 ${folderName})</font>${suffix}`;
      });
    }
  } catch (err) {
    showToast("Could not open folder dialog. Make sure desktop app is active.", 'error');
  }
};

document.getElementById('btn-download-yanfaa').onclick = async () => {
  const checked = document.querySelectorAll('.yanfaa-cb:checked');
  if (checked.length === 0) return showToast("Select videos.", 'warning');

  const indices = Array.from(checked).map(cb => parseInt(cb.dataset.idx));
  const defaultDir = document.getElementById('setting-download-dir').value.trim() || 'downloads';

  showDownloadConfirmModal(yanfaaSlug, defaultDir, async (result) => {
    const payload = {
      course_slug: result.title || yanfaaSlug,
      video_indices: indices,
      download_dirs: {},
      auto_download: result.autoStart
    };

    indices.forEach(idx => {
      payload.download_dirs[idx] = result.downloadDir;
    });

    try {
      const res = await request('/api/yanfaa/download', 'POST', payload);
      showToast(`Queued ${res.job_ids.length} downloads!`, 'success');
      document.querySelector('[data-tab="status"]').click();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

document.getElementById('btn-complete-yanfaa').onclick = async () => {
  const checked = document.querySelectorAll('.yanfaa-cb:checked');
  if (checked.length === 0) return showToast("Select at least one video.", 'warning');

  showToast("Marking as completed...", 'info');
  try {
    for (const cb of checked) {
      const idx = parseInt(cb.dataset.idx);
      const name = yanfaaVideos[idx].title;
      await request('/api/course/jobs/manual-complete', 'POST', { title: name });
    }
    showToast(`Marked ${checked.length} videos completed!`, 'success');
    // Refresh the list view to show them as completed
    document.getElementById('btn-fetch-yanfaa').click();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ── M3U8 Tab Logic ────────────────────────────────────────────────────────
document.getElementById('btn-download-m3u8').onclick = async () => {
  const urlsText = document.getElementById('m3u8-urls').value.trim();
  if (!urlsText) return showToast("Provide M3U8 URL(s).", 'warning');

  const urls = urlsText.split('\n').map(u => u.trim()).filter(Boolean);
  const titlesText = document.getElementById('m3u8-titles').value.trim();
  const names = titlesText ? titlesText.split('\n').map(t => t.trim()).filter(Boolean) : null;
  const referer = document.getElementById('m3u8-referer').value.trim();
  const defaultDir = document.getElementById('setting-download-dir').value.trim() || 'downloads';

  const initialTitle = (names && names.length > 0) ? names[0] : "m3u8-batch";

  showDownloadConfirmModal(initialTitle, defaultDir, async (result) => {
    const payload = {
      urls,
      names: names || urls.map((u, i) => `${result.title}_${i + 1}`),
      download_path: result.downloadDir,
      referer: referer || null,
      use_scheduler: document.getElementById('use-scheduler-m3u8').checked,
      auto_download: result.autoStart
    };

    try {
      const res = await request('/api/course/m3u8/batch', 'POST', payload);
      showToast(`Queued ${res.job_ids.length} jobs!`, 'success');
      document.querySelector('[data-tab="status"]').click();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
};

// ── Downloads Tab: WebSocket + Polling Hybrid ─────────────────────────────
let ws = null;

function connectWebSocket() {
  if (ws && ws.readyState <= 1) return;

  try {
    ws = new WebSocket(WS_URL);
    
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'progress' || data.type === 'status_change') {
          updateJobInList(data);
        }
      } catch {}
    };

    ws.onclose = () => { ws = null; };
    ws.onerror = () => { ws = null; };
  } catch {
    ws = null;
  }
}

function disconnectWebSocket() {
  if (ws) {
    ws.close();
    ws = null;
  }
}

function updateJobInList(data) {
  const jobEl = document.querySelector(`[data-job-id="${data.job_id}"]`);
  if (!jobEl) return;

  // Update progress bar
  if (data.progress != null) {
    const bar = jobEl.querySelector('.status-progress');
    if (bar) bar.style.width = `${data.progress}%`;
    
    const pctEl = jobEl.querySelector('.job-pct');
    if (pctEl) pctEl.textContent = `${data.progress.toFixed(1)}%`;
  }

  // Update speed
  if (data.speed) {
    const speedEl = jobEl.querySelector('.job-speed');
    if (speedEl) speedEl.textContent = data.speed;
  }

  // Update status badge
  if (data.status) {
    const badge = jobEl.querySelector('.badge');
    if (badge) {
      badge.textContent = data.status;
      badge.className = `badge bad-${data.status}`;
    }
  }
}

let checkedJobIds = new Set();

// Bind bulk status actions once
document.getElementById('status-select-all').onchange = (e) => {
  const isChecked = e.target.checked;
  const boxes = document.querySelectorAll('.status-cb');
  boxes.forEach(cb => {
    cb.checked = isChecked;
    const id = cb.dataset.id;
    if (isChecked) {
      checkedJobIds.add(id);
    } else {
      checkedJobIds.delete(id);
    }
  });
};

document.getElementById('btn-bulk-resume').onclick = async () => {
  if (checkedJobIds.size === 0) return showToast("Select at least one job first.", "warning");
  showToast("Resuming selected...", "info");
  try {
    for (const id of checkedJobIds) {
      await request(`/api/jobs/${id}/resume`, 'POST');
    }
    showToast("Selected jobs resumed", "success");
    pollJobs();
  } catch (err) { showToast(err.message, "error"); }
};

document.getElementById('btn-bulk-cancel').onclick = async () => {
  if (checkedJobIds.size === 0) return showToast("Select at least one job first.", "warning");
  showToast("Cancelling selected...", "info");
  try {
    for (const id of checkedJobIds) {
      await request(`/api/jobs/${id}/cancel`, 'POST');
    }
    showToast("Selected jobs cancelled", "info");
    pollJobs();
  } catch (err) { showToast(err.message, "error"); }
};

document.getElementById('btn-bulk-delete').onclick = async () => {
  if (checkedJobIds.size === 0) return showToast("Select at least one job first.", "warning");
  if (!confirm("Remove selected jobs from list?")) return;
  showToast("Deleting selected...", "info");
  try {
    for (const id of checkedJobIds) {
      await request(`/api/jobs/${id}`, 'DELETE');
      checkedJobIds.delete(id);
    }
    showToast("Selected jobs removed", "info");
    pollJobs();
  } catch (err) { showToast(err.message, "error"); }
};

async function pollJobs() {
  const list = document.getElementById('status-jobs-list');
  try {
    const res = await request('/api/course/jobs');
    const jobs = res.jobs || [];

    if (jobs.length === 0) {
      list.innerHTML = '<li class="empty">No active downloads</li>';
      return;
    }

    list.innerHTML = jobs.slice(0, 200).map(job => {
      const isCompleted = job.status === 'completed';
      const isFailed = job.status === 'failed';
      const isPaused = job.status === 'paused';
      const isDownloading = job.status === 'downloading';
      const isQueued = job.status === 'queued';
      
      const progress = job.progress || 0;
      const speed = job.speed || '';
      const badgeClass = isCompleted ? 'bad-completed' 
                       : isFailed ? 'bad-failed' 
                       : isPaused ? 'bad-paused' 
                       : 'bad-downloading';

      const displayName = job.title || decodeURIComponent(job.url.split('/').pop().split('?')[0]).substring(0, 35);
      const isChecked = checkedJobIds.has(job.id) ? 'checked' : '';

      // Render control actions (Pause / Resume / Cancel)
      let actionsHtml = '';
      if (isDownloading || isQueued) {
        actionsHtml = `
          <button class="btn btn-secondary btn-sm btn-pause-popup" data-id="${job.id}" style="padding: 2px 6px; font-size: 0.65rem; margin-right: 4px;">Pause</button>
          <button class="btn btn-secondary btn-sm btn-cancel-popup" data-id="${job.id}" style="padding: 2px 6px; font-size: 0.65rem;">Cancel</button>
        `;
      } else if (isPaused) {
        actionsHtml = `
          <button class="btn btn-secondary btn-sm btn-resume-popup" data-id="${job.id}" style="padding: 2px 6px; font-size: 0.65rem; margin-right: 4px;">Resume</button>
          <button class="btn btn-secondary btn-sm btn-cancel-popup" data-id="${job.id}" style="padding: 2px 6px; font-size: 0.65rem;">Cancel</button>
        `;
      } else if (isFailed) {
        actionsHtml = `
          <button class="btn btn-secondary btn-sm btn-retry-popup" data-id="${job.id}" style="padding: 2px 6px; font-size: 0.65rem; margin-right: 4px;">Retry</button>
          <button class="btn btn-secondary btn-sm btn-cancel-popup" data-id="${job.id}" style="padding: 2px 6px; font-size: 0.65rem;">Cancel</button>
        `;
      } else if (isCompleted) {
        actionsHtml = `
          <button class="btn btn-secondary btn-sm btn-delete-popup" data-id="${job.id}" style="padding: 2px 6px; font-size: 0.65rem; color: var(--error);">Delete</button>
        `;
      }

      return `
        <li data-job-id="${job.id}" style="padding: 10px 0; display: flex; align-items: flex-start; gap: 8px;">
          <input type="checkbox" class="status-cb" data-id="${job.id}" ${isChecked} style="margin-top: 4px;">
          <div style="flex: 1; min-width: 0;">
            <div class="status-row">
              <span class="status-name" title="${job.url}">${displayName}</span>
              <span class="badge ${badgeClass}">${job.status}</span>
            </div>
            ${!isCompleted && !isFailed ? `
              <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.68rem; color:var(--text-muted); margin-top:3px;">
                <span class="job-pct">${progress.toFixed(1)}%</span>
                ${speed ? `<span class="job-speed">${speed}</span>` : '<span class="job-speed"></span>'}
              </div>
              <div class="status-progress-wrap">
                <div class="status-progress" style="width: ${progress}%"></div>
              </div>
            ` : ''}
            ${isFailed ? `
              <div style="font-size:0.63rem; color:var(--error); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-top:3px; margin-bottom:5px;">
                ${job.error || 'Unknown error'}
              </div>
            ` : ''}
            <div style="display: flex; justify-content: flex-end; margin-top: 5px;">
              ${actionsHtml}
            </div>
          </div>
        </li>
      `;
    }).join('');

    // Bind individual checkboxes changes
    list.querySelectorAll('.status-cb').forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.id;
        if (cb.checked) {
          checkedJobIds.add(id);
        } else {
          checkedJobIds.delete(id);
        }
      };
    });

    // Bind event handlers to control buttons
    list.querySelectorAll('.btn-pause-popup').forEach(btn => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        try {
          await request(`/api/jobs/${id}/pause`, 'POST');
          showToast("Job paused", "warning");
          pollJobs();
        } catch (err) { showToast(err.message, "error"); }
      };
    });

    list.querySelectorAll('.btn-resume-popup').forEach(btn => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        try {
          await request(`/api/jobs/${id}/resume`, 'POST');
          showToast("Job resumed", "success");
          pollJobs();
        } catch (err) { showToast(err.message, "error"); }
      };
    });

    list.querySelectorAll('.btn-cancel-popup').forEach(btn => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        try {
          await request(`/api/jobs/${id}/cancel`, 'POST');
          showToast("Job cancelled", "info");
          pollJobs();
        } catch (err) { showToast(err.message, "error"); }
      };
    });

    list.querySelectorAll('.btn-retry-popup').forEach(btn => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        try {
          await request(`/api/jobs/${id}/retry`, 'POST');
          showToast("Job retried", "success");
          pollJobs();
        } catch (err) { showToast(err.message, "error"); }
      };
    });

    list.querySelectorAll('.btn-delete-popup').forEach(btn => {
      btn.onclick = async (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        try {
          await request(`/api/jobs/${id}`, 'DELETE');
          showToast("Job removed", "info");
          pollJobs();
        } catch (err) { showToast(err.message, "error"); }
      };
    });
  } catch (err) {
    list.innerHTML = `<li class="empty" style="color: var(--error);">Cannot reach Thunder backend</li>`;
  }
}

// ── Settings Tab Logic ────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await request('/api/settings');
    const settings = res.settings || {};
    
    let downloadDir = settings.download_dir || 'downloads';
    // Strip quotes
    if ((downloadDir.startsWith('"') && downloadDir.endsWith('"')) || (downloadDir.startsWith("'") && downloadDir.endsWith("'"))) {
      downloadDir = downloadDir.substring(1, downloadDir.length - 1);
    }
    
    document.getElementById('setting-download-dir').value = downloadDir;
    document.getElementById('setting-concurrency').value = settings.global_max_concurrent || '8';
    
    const autoStart = settings.auto_start_downloads || 'true';
    document.getElementById('setting-auto-start').value = autoStart;

    // Sync to chrome.storage.local so the content scripts can access them
    chrome.storage.local.set({
      thunder_grab_save_dir: downloadDir,
      thunder_grab_auto_start: autoStart
    });
  } catch (err) {
    showToast("Failed to load settings", "error");
  }
}

document.getElementById('btn-save-settings').onclick = async () => {
  const downloadDir = document.getElementById('setting-download-dir').value.trim();
  const concurrency = document.getElementById('setting-concurrency').value.trim();
  const autoStart = document.getElementById('setting-auto-start').value;
  
  if (!downloadDir) return showToast("Download path cannot be empty", "warning");
  
  const payload = {
    settings: {
      download_dir: downloadDir,
      global_max_concurrent: concurrency,
      auto_start_downloads: autoStart
    }
  };

  try {
    await request('/api/settings', 'PUT', payload);
    
    // Sync to chrome.storage.local so the content scripts can access them immediately
    chrome.storage.local.set({
      thunder_grab_save_dir: downloadDir,
      thunder_grab_auto_start: autoStart
    }, () => {
      showToast("Settings saved successfully!", "success");
    });
  } catch (err) {
    showToast(err.message, "error");
  }
};

document.getElementById('btn-popup-browse').onclick = async (e) => {
  e.preventDefault();
  try {
    const res = await request('/api/settings/browse-folder', 'POST');
    if (res.path) {
      document.getElementById('setting-download-dir').value = res.path;
    }
  } catch (err) {
    showToast("Could not open folder picker. Make sure Thunder GUI is running.", "error");
  }
};

// ── Auto-Grab Course Handler ──────────────────────────────────────────────
document.getElementById('btn-start-grab').onclick = async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return showToast("No active tab found.", 'warning');
  
  const activeTab = tabs[0];
  if (!activeTab.url || !activeTab.url.startsWith("http")) {
    return showToast("Navigate to a course or lesson page first.", 'warning');
  }

  const initialTitle = activeTab.title ? activeTab.title.split('|')[0].split('-')[0].trim().replace(/[^a-zA-Z0-9_ -]/g, '') : 'course';
  const defaultDir = document.getElementById('setting-download-dir').value.trim() || 'downloads';

  showDownloadConfirmModal(initialTitle, defaultDir, async (result) => {
    chrome.storage.local.set({
      thunder_grab_save_dir: result.downloadDir,
      thunder_grab_auto_start: result.autoStart ? "true" : "false",
      thunder_grab_course_name: result.title || initialTitle
    }, () => {
      showToast("Starting auto grab on page...", 'info');
      chrome.tabs.sendMessage(activeTab.id, { action: "START_AUTO_GRAB" }, (res) => {
        if (chrome.runtime.lastError) {
          showToast("Refresh the page first to load the extension.", 'error');
        } else if (res && res.ok) {
          showToast("Auto grab started!", 'success');
          setTimeout(() => window.close(), 800);
        }
      });
    });
  });
};

function showDownloadConfirmModal(initialTitle, initialSaveDir, onConfirm) {
  const modal = document.getElementById('confirm-modal');
  const titleInput = document.getElementById('modal-title');
  const dirInput = document.getElementById('modal-download-dir');
  const actionSelect = document.getElementById('modal-auto-start');

  titleInput.value = initialTitle || '';
  dirInput.value = initialSaveDir || '';

  modal.style.display = 'flex';

  document.getElementById('btn-modal-close').onclick = () => { modal.style.display = 'none'; };
  document.getElementById('btn-modal-cancel').onclick = () => { modal.style.display = 'none'; };

  document.getElementById('btn-modal-browse').onclick = async (e) => {
    e.preventDefault();
    try {
      const res = await request('/api/settings/browse-folder', 'POST');
      if (res.path) {
        dirInput.value = res.path;
      }
    } catch (err) {
      showToast("Make sure Thunder GUI is running to pick a folder.", "error");
    }
  };

  document.getElementById('btn-modal-start').onclick = () => {
    const title = titleInput.value.trim();
    const downloadDir = dirInput.value.trim();
    const autoStart = actionSelect.value === 'true';

    modal.style.display = 'none';
    onConfirm({ title, downloadDir, autoStart });
  };
}
