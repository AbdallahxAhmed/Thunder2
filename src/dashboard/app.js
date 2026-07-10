/**
 * Thunder Course Downloader Dashboard JS Logic
 * Pure JS, hash routing, custom rendering, real-time polling
 */

// ── API Wrapper ───────────────────────────────────────────────────────────
const api = {
  getJobs: () => fetch('/api/course/jobs').then(r => r.json()),
  getHistory: () => fetch('/api/downloads/history').then(r => r.json()).catch(() => ({ history: [] })),
  getSessions: () => fetch('/api/auth/sessions').then(r => r.json()),
  getSettings: () => fetch('/api/settings').then(r => r.json()),
  updateSettings: (s) => fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(s) }).then(r => r.json()),
  
  scanHAR: (dir) => fetch(`/api/course/har/scan?directory=${encodeURIComponent(dir)}`, { method: 'POST' }).then(r => r.json()),
  extractHAR: (path) => fetch('/api/course/har/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ har_path: path }) }).then(r => r.json()),
  downloadHAR: (payload) => fetch('/api/course/har/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json()),
  
  getYanfaaCourse: (slug) => fetch(`/api/yanfaa/course?course_slug=${encodeURIComponent(slug)}`, { method: 'POST' }).then(r => r.json()),
  downloadYanfaa: (payload) => fetch('/api/yanfaa/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json()),
  
  batchM3U8: (payload) => fetch('/api/course/m3u8/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }).then(r => r.json()),
  pauseJob: (id) => fetch(`/api/jobs/${id}/pause`, { method: 'POST' }).then(r => r.json()),
  resumeJob: (id) => fetch(`/api/jobs/${id}/resume`, { method: 'POST' }).then(r => r.json()),
  cancelJob: (id) => fetch(`/api/jobs/${id}/cancel`, { method: 'POST' }).then(r => r.json()),
  deleteJob: (id) => fetch(`/api/jobs/${id}`, { method: 'DELETE' }).then(r => r.json()),
  retryJob: (id) => fetch(`/api/jobs/${id}/retry`, { method: 'POST' }).then(r => r.json()),
  getHealth: () => fetch('/api/health').then(r => r.json()),
};

// ── Toast Notification System ─────────────────────────────────────────────
const toast = {
  show: (msg, type = 'info') => {
    const container = document.getElementById('toasts');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast badge-${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('hide');
      setTimeout(() => el.remove(), 300);
    }, 4000);
  },
  success: (msg) => toast.show(msg, 'success'),
  error: (msg) => toast.show(msg, 'error'),
  info: (msg) => toast.show(msg, 'info'),
  warning: (msg) => toast.show(msg, 'warning'),
};

// ── Navigation Rendering ──────────────────────────────────────────────────
const NAV_ITEMS = [
  { path: '/', label: 'Overview', icon: '◆' },
  { path: '/har', label: 'CloudNative (HAR)', icon: '☁' },
  { path: '/yanfaa', label: 'Yanfaa API', icon: '🎓' },
  { path: '/m3u8', label: 'Direct M3U8', icon: '🔗' },
  { path: '/settings', label: 'Settings & Sessions', icon: '⚙' },
];

function renderSidebar(currentPath) {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="sidebar-logo">Thunder Course</div>
      <div class="sidebar-desc">DRM & Course Downloader</div>
    </div>
    <ul class="sidebar-menu">
      <div class="menu-title">Main</div>
      ${NAV_ITEMS.map(item => `
        <li class="menu-item">
          <a class="menu-link ${currentPath === item.path ? 'active' : ''}" href="#${item.path}">
            <span class="menu-icon">${item.icon}</span>
            ${item.label}
          </a>
        </li>
      `).join('')}
    </ul>
  `;
}

// ── Shared State ──────────────────────────────────────────────────────────
let activeJobs = [];
let checkedDashboardJobIds = new Set();
let jobPollingInterval = null;

function startJobPolling() {
  if (jobPollingInterval) clearInterval(jobPollingInterval);
  pollJobs();
  jobPollingInterval = setInterval(pollJobs, 3000);
}

function pollJobs() {
  api.getJobs().then(data => {
    activeJobs = data.jobs || [];
    updateDashboardJobsList();
  }).catch(() => {});
}

// ── Pages ─────────────────────────────────────────────────────────────────

// Page: Overview
function pageOverview(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Overview</h1>
      <p class="page-desc">System health and running download queues</p>
    </div>
    <div class="card-grid">
      <div class="card">
        <div class="card-icon">⚡</div>
        <div class="card-title" id="active-count">0</div>
        <div class="card-desc">Active / Queued Downloads</div>
      </div>
      <div class="card">
        <div class="card-icon">✅</div>
        <div class="card-title" id="complete-count">0</div>
        <div class="card-desc">Completed Downloads</div>
      </div>
      <div class="card">
        <div class="card-icon">🛠️</div>
        <div class="card-title" id="health-status">Checking...</div>
        <div class="card-desc">Thunder Daemon Status</div>
      </div>
    </div>
    <div class="section">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h3 style="margin: 0; font-weight: 600;">Active Jobs</h3>
        <div style="display: flex; gap: 8px; align-items: center;">
          <label class="checkbox-label" style="font-size: 0.75rem; margin-right: 12px; display: flex; align-items: center; gap: 6px;">
            <input type="checkbox" class="checkbox" id="dashboard-select-all">
            <span>Select All</span>
          </label>
          <button class="btn btn-secondary btn-sm" id="btn-dashboard-bulk-resume" style="padding: 6px 10px; font-size: 0.75rem; color: var(--success);" title="Resume selected downloads">▶ Resume</button>
          <button class="btn btn-secondary btn-sm" id="btn-dashboard-bulk-cancel" style="padding: 6px 10px; font-size: 0.75rem; color: var(--error);" title="Cancel selected downloads">⏹ Cancel</button>
          <button class="btn btn-secondary btn-sm" id="btn-dashboard-bulk-delete" style="padding: 6px 10px; font-size: 0.75rem; opacity: 0.8;" title="Remove selected from history">🗑 Delete</button>
        </div>
      </div>
      <div class="card" style="padding: 0; overflow: hidden;">
        <div id="jobs-list" class="download-list">
          <div class="empty-state">
            <div class="empty-icon">📭</div>
            <div class="empty-text">No active jobs found. Submitting a new job will trigger real-time updates.</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Bind bulk actions in overview page:
  setTimeout(() => {
    const selectAll = document.getElementById('dashboard-select-all');
    if (selectAll) {
      selectAll.onchange = (e) => {
        const isChecked = e.target.checked;
        const boxes = document.querySelectorAll('.dashboard-cb');
        boxes.forEach(cb => {
          cb.checked = isChecked;
          const id = cb.dataset.id;
          if (isChecked) {
            checkedDashboardJobIds.add(id);
          } else {
            checkedDashboardJobIds.delete(id);
          }
        });
      };
    }

    const btnResume = document.getElementById('btn-dashboard-bulk-resume');
    if (btnResume) {
      btnResume.onclick = async () => {
        if (checkedDashboardJobIds.size === 0) return toast.warning("Select at least one job first.");
        toast.info("Resuming selected...");
        try {
          for (const id of checkedDashboardJobIds) {
            await api.resumeJob(id);
          }
          toast.success("Selected jobs resumed");
          pollJobs();
        } catch (err) { toast.error(err.message); }
      };
    }

    const btnCancel = document.getElementById('btn-dashboard-bulk-cancel');
    if (btnCancel) {
      btnCancel.onclick = async () => {
        if (checkedDashboardJobIds.size === 0) return toast.warning("Select at least one job first.");
        toast.info("Cancelling selected...");
        try {
          for (const id of checkedDashboardJobIds) {
            await api.cancelJob(id);
          }
          toast.success("Selected jobs cancelled");
          pollJobs();
        } catch (err) { toast.error(err.message); }
      };
    }

    const btnDelete = document.getElementById('btn-dashboard-bulk-delete');
    if (btnDelete) {
      btnDelete.onclick = async () => {
        if (checkedDashboardJobIds.size === 0) return toast.warning("Select at least one job first.");
        if (!confirm("Remove selected jobs from list?")) return;
        toast.info("Deleting selected...");
        try {
          for (const id of checkedDashboardJobIds) {
            await api.deleteJob(id);
            checkedDashboardJobIds.delete(id);
          }
          toast.success("Selected jobs removed");
          pollJobs();
        } catch (err) { toast.error(err.message); }
      };
    }
  }, 50);

  // Fetch health check
  api.getHealth().then(h => {
    const el = document.getElementById('health-status');
    if (el) {
      el.textContent = h.status === 'healthy' ? 'Healthy' : 'Degraded';
      el.style.color = h.status === 'healthy' ? 'var(--success)' : 'var(--error)';
    }
  }).catch(() => {
    const el = document.getElementById('health-status');
    if (el) el.textContent = 'Unreachable';
  });

  updateDashboardJobsList();
}

function updateDashboardJobsList() {
  const listEl = document.getElementById('jobs-list');
  const activeCountEl = document.getElementById('active-count');
  const completeCountEl = document.getElementById('complete-count');

  if (!listEl) return;

  const downloading = activeJobs.filter(j => j.status === 'downloading');
  const queued = activeJobs.filter(j => j.status === 'queued');
  const completed = activeJobs.filter(j => j.status === 'completed');

  if (activeCountEl) activeCountEl.textContent = downloading.length + queued.length;
  if (completeCountEl) completeCountEl.textContent = completed.length;

  if (activeJobs.length === 0) {
    checkedDashboardJobIds.clear();
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-text">No active jobs found. Submitting a new job will trigger real-time updates.</div>
      </div>
    `;
    return;
  }

  listEl.innerHTML = activeJobs.map(job => {
    const isCompleted = job.status === 'completed';
    const isFailed = job.status === 'failed';
    const isPaused = job.status === 'paused';
    const isDownloading = job.status === 'downloading';
    const isQueued = job.status === 'queued';
    
    const progress = job.progress || 0;
    const speed = job.speed || '';
    const badgeClass = isCompleted ? 'badge-success' : isFailed ? 'badge-error' : isPaused ? 'badge-info' : 'badge-warning';

    const displayName = job.title || decodeURIComponent(job.url.split('/').pop().split('?')[0]).substring(0, 85);

    // Control buttons based on status
    let actionsHtml = '';
    if (isDownloading || isQueued) {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm btn-pause" data-id="${job.id}" style="padding: 4px 8px; font-size: 0.7rem; margin-right: 6px;">Pause</button>
        <button class="btn btn-secondary btn-sm btn-cancel" data-id="${job.id}" style="padding: 4px 8px; font-size: 0.7rem;">Cancel</button>
      `;
    } else if (isPaused) {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm btn-resume" data-id="${job.id}" style="padding: 4px 8px; font-size: 0.7rem; margin-right: 6px;">Resume</button>
        <button class="btn btn-secondary btn-sm btn-cancel" data-id="${job.id}" style="padding: 4px 8px; font-size: 0.7rem;">Cancel</button>
      `;
    } else if (isFailed) {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm btn-retry" data-id="${job.id}" style="padding: 4px 8px; font-size: 0.7rem; margin-right: 6px;">Retry</button>
        <button class="btn btn-secondary btn-sm btn-cancel" data-id="${job.id}" style="padding: 4px 8px; font-size: 0.7rem;">Cancel</button>
      `;
    } else {
      actionsHtml = `
        <button class="btn btn-secondary btn-sm btn-delete" data-id="${job.id}" style="padding: 4px 8px; font-size: 0.7rem; color: var(--error);">Delete</button>
      `;
    }

    const isChecked = checkedDashboardJobIds.has(job.id) ? 'checked' : '';

    return `
      <div class="job-item" style="display: flex; align-items: flex-start; gap: 12px;">
        <input type="checkbox" class="checkbox dashboard-cb" data-id="${job.id}" ${isChecked} style="margin-top: 6px;">
        <div style="flex: 1; min-width: 0;">
          <div class="job-meta">
            <div class="job-title" title="${job.url}">${displayName}</div>
            <span class="badge ${badgeClass}">${job.status}</span>
          </div>
          <div class="job-info" style="margin-top: 4px; display: flex; justify-content: space-between;">
            <span>Engine: ${job.engine} | Created: ${new Date(job.created_at).toLocaleTimeString()}</span>
            ${speed ? `<span style="color: var(--text-accent); font-weight: 500;">${speed}</span>` : ''}
          </div>
          ${!isCompleted && !isFailed ? `
            <div class="progress-bar-wrap">
              <div class="progress-bar" style="width: ${progress}%"></div>
            </div>
            <div style="font-size: 0.75rem; text-align: right; color: var(--text-muted); margin-top: 4px;">
              ${progress.toFixed(1)}%
            </div>
          ` : ''}
          ${isFailed ? `
            <div style="font-size: 0.75rem; color: var(--error); margin-top: 6px; margin-bottom: 6px;">Error: ${job.error || 'Unknown error'}</div>
          ` : ''}
          <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
            ${actionsHtml}
          </div>
        </div>
      </div>
    `;
  }).join('');

  // Bind individual checkboxes changes
  listEl.querySelectorAll('.dashboard-cb').forEach(cb => {
    cb.onchange = () => {
      const id = cb.dataset.id;
      if (cb.checked) {
        checkedDashboardJobIds.add(id);
      } else {
        checkedDashboardJobIds.delete(id);
      }
    };
  });

  // Bind click handlers to control buttons
  listEl.querySelectorAll('.btn-pause').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      api.pauseJob(id).then(res => {
        toast.warning("Job paused");
        pollJobs();
      }).catch(err => toast.error(err.message));
    };
  });

  listEl.querySelectorAll('.btn-resume').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      api.resumeJob(id).then(res => {
        toast.success("Job resumed");
        pollJobs();
      }).catch(err => toast.error(err.message));
    };
  });

  listEl.querySelectorAll('.btn-cancel').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      api.cancelJob(id).then(res => {
        toast.info("Job cancelled");
        pollJobs();
      }).catch(err => toast.error(err.message));
    };
  });

  listEl.querySelectorAll('.btn-retry').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      btn.disabled = true;
      btn.textContent = "Retrying...";
      api.retryJob(id).then(res => {
        toast.success("Job retry queued");
        pollJobs();
      }).catch(err => {
        toast.error(err.message);
        btn.disabled = false;
        btn.textContent = "Retry";
      });
    };
  });

  listEl.querySelectorAll('.btn-delete').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      const id = btn.dataset.id;
      api.deleteJob(id).then(res => {
        toast.info("Job deleted from history");
        pollJobs();
      }).catch(err => toast.error(err.message));
    };
  });
}

// Page: CloudNative (HAR)
function pageHAR(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">CloudNative Downloader</h1>
      <p class="page-desc">Extract M3U8 links from browser HAR logs and download automatically</p>
    </div>
    
    <div class="card">
      <div class="form-group">
        <label class="label">HAR File / Directory Path</label>
        <input type="text" class="input" id="har-path" placeholder="D:\\courses\\lessons.har" />
        <div class="hint">Enter absolute path to the .har file or directory to scan.</div>
      </div>
      <div style="display: flex; gap: 12px;">
        <button class="btn btn-secondary" id="btn-scan">Scan Directory</button>
        <button class="btn btn-primary" id="btn-extract">Extract & Show Lessons</button>
      </div>
    </div>

    <div class="card" id="har-results-card" style="display: none;">
      <div class="form-group">
        <label class="label">Course Folder Name</label>
        <input type="text" class="input" id="course-name" placeholder="kubernetes-fundamentals" />
      </div>
      
      <div class="table-wrap" style="margin-bottom: 20px;">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 40px;"><input type="checkbox" class="checkbox" id="select-all-lessons" checked /></th>
              <th>Index</th>
              <th>Video Target Title</th>
            </tr>
          </thead>
          <tbody id="lessons-table-body"></tbody>
        </table>
      </div>

      <div style="display: flex; gap: 12px; align-items: center;">
        <label class="checkbox-label">
          <input type="checkbox" class="checkbox" id="use-scheduler" />
          <span>Use human-like scheduling delays</span>
        </label>
        <button class="btn btn-primary" id="btn-download-har" style="margin-left: auto;">Download Selected</button>
      </div>
    </div>
  `;

  let extractedUrls = [];
  let extractedNames = [];

  const pathInput = document.getElementById('har-path');
  const resultsCard = document.getElementById('har-results-card');
  const tableBody = document.getElementById('lessons-table-body');
  const selectAll = document.getElementById('select-all-lessons');

  document.getElementById('btn-scan').onclick = () => {
    const dir = pathInput.value.trim() || '.';
    api.scanHAR(dir).then(res => {
      if (res.files && res.files.length > 0) {
        pathInput.value = res.files[0].path;
        toast.success(`Found ${res.files.length} HAR files! First selected.`);
      } else {
        toast.warning("No HAR files found in directory.");
      }
    }).catch(err => toast.error(`Scan error: ${err.message}`));
  };

  document.getElementById('btn-extract').onclick = () => {
    const path = pathInput.value.trim();
    if (!path) return toast.warning("Provide HAR path first.");

    toast.info("Extracting URLs...");
    api.extractHAR(path).then(res => {
      extractedUrls = res.urls;
      extractedNames = res.names;

      if (extractedUrls.length === 0) {
        toast.warning("No video URLs found in HAR.");
        resultsCard.style.display = 'none';
        return;
      }

      // Pre-fill course name
      const cleanName = path.replace(/\\/g, '/').split('/').pop().replace('.har', '').replace('.json', '');
      document.getElementById('course-name').value = cleanName;

      // Populate table
      tableBody.innerHTML = extractedNames.map((name, i) => `
        <tr>
          <td><input type="checkbox" class="checkbox lesson-cb" data-idx="${i}" checked /></td>
          <td>${i + 1}</td>
          <td>${name}</td>
        </tr>
      `).join('');

      resultsCard.style.display = 'block';
      toast.success(`Extracted ${extractedUrls.length} lessons!`);
    }).catch(err => toast.error(err.message));
  };

  selectAll.onchange = (e) => {
    document.querySelectorAll('.lesson-cb').forEach(cb => cb.checked = e.target.checked);
  };

  document.getElementById('btn-download-har').onclick = () => {
    const checkedBoxes = document.querySelectorAll('.lesson-cb:checked');
    if (checkedBoxes.length === 0) return toast.warning("Select at least one lesson.");

    const urls = [];
    const names = [];
    checkedBoxes.forEach(cb => {
      const idx = parseInt(cb.dataset.idx);
      urls.push(extractedUrls[idx]);
      names.push(extractedNames[idx]);
    });

    const payload = {
      har_path: pathInput.value.trim(),
      course_name: document.getElementById('course-name').value.trim() || 'har-course',
      auto_download: true,
      use_scheduler: document.getElementById('use-scheduler').checked
    };

    toast.info("Submitting batch downloads...");
    api.downloadHAR(payload).then(res => {
      toast.success(`Queued ${res.job_ids.length} downloads!`);
      location.hash = '/';
    }).catch(err => toast.error(err.message));
  };
}

// Page: Yanfaa API
function pageYanfaa(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Yanfaa API Downloader</h1>
      <p class="page-desc">Browse course video maps and download using high-speed engines</p>
    </div>

    <div class="card">
      <div class="form-group">
        <label class="label">Course Slug / URL</label>
        <input type="text" class="input" id="course-slug" placeholder="e.g. The-Right-Steps-To-PERFECT-Composition" />
        <div class="hint">Slug can be extracted from course page URL.</div>
      </div>
      <button class="btn btn-primary" id="btn-fetch-yanfaa">Fetch Course Videos</button>
    </div>

    <div class="card" id="yanfaa-results-card" style="display: none;">
      <h3 id="yanfaa-course-title" style="margin-bottom: 12px; font-weight: 600;">Course Videos</h3>
      <div class="table-wrap" style="margin-bottom: 20px;">
        <table class="table">
          <thead>
            <tr>
              <th style="width: 40px;"><input type="checkbox" class="checkbox" id="select-all-yanfaa" checked /></th>
              <th>Index</th>
              <th>Lesson Title</th>
              <th>Chapter / Part</th>
            </tr>
          </thead>
          <tbody id="yanfaa-table-body"></tbody>
        </table>
      </div>
      <button class="btn btn-primary" id="btn-download-yanfaa">Download Selected</button>
    </div>
  `;

  let courseVideos = [];
  let slug = '';
  const resultsCard = document.getElementById('yanfaa-results-card');
  const tableBody = document.getElementById('yanfaa-table-body');
  const selectAll = document.getElementById('select-all-yanfaa');

  document.getElementById('btn-fetch-yanfaa').onclick = () => {
    let input = document.getElementById('course-slug').value.trim();
    if (!input) return toast.warning("Provide course slug.");

    // Extract slug from full URL if pasted
    const matches = input.match(/single\/([^/?#]+)/);
    if (matches) input = matches[1];
    slug = input;

    toast.info("Fetching course info...");
    api.getYanfaaCourse(slug).then(res => {
      courseVideos = res.videos || [];
      document.getElementById('yanfaa-course-title').textContent = res.title;
      
      tableBody.innerHTML = courseVideos.map((v, i) => `
        <tr>
          <td><input type="checkbox" class="checkbox yanfaa-cb" data-idx="${i}" checked /></td>
          <td>${v.index + 1}</td>
          <td>${v.title}</td>
          <td>${v.chapter || 'Main'}</td>
        </tr>
      `).join('');

      resultsCard.style.display = 'block';
      toast.success(`Found ${courseVideos.length} videos!`);
    }).catch(err => toast.error(err.message));
  };

  selectAll.onchange = (e) => {
    document.querySelectorAll('.yanfaa-cb').forEach(cb => cb.checked = e.target.checked);
  };

  document.getElementById('btn-download-yanfaa').onclick = () => {
    const checked = document.querySelectorAll('.yanfaa-cb:checked');
    if (checked.length === 0) return toast.warning("Select videos first.");

    const indices = Array.from(checked).map(cb => parseInt(cb.dataset.idx));
    const payload = {
      course_slug: slug,
      video_indices: indices
    };

    toast.info("Queueing Yanfaa downloads...");
    api.downloadYanfaa(payload).then(res => {
      toast.success(`Queued ${res.job_ids.length} downloads!`);
      location.hash = '/';
    }).catch(err => toast.error(err.message));
  };
}

// Page: Direct M3U8
function pageM3U8(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Direct M3U8 Downloader</h1>
      <p class="page-desc">Batch download raw HLS / DASH manifest streams with customized HTTP Referer</p>
    </div>

    <div class="card">
      <div class="form-group">
        <label class="label">M3U8 Manifest URLs (one per line)</label>
        <textarea class="input" id="m3u8-urls" placeholder="https://domain.com/path/to/stream.m3u8"></textarea>
      </div>
      <div class="form-group">
        <label class="label">Video Titles (one per line, matches URLs order)</label>
        <textarea class="input" id="m3u8-titles" placeholder="01-Getting Started"></textarea>
      </div>
      <div class="form-group">
        <label class="label">HTTP Referer Headers (optional)</label>
        <input type="text" class="input" id="m3u8-referer" placeholder="https://origin-platform.com/" />
      </div>
      
      <div style="display: flex; gap: 12px; align-items: center; margin-top: 10px;">
        <label class="checkbox-label">
          <input type="checkbox" class="checkbox" id="m3u8-use-scheduler" />
          <span>Use smart random breaks</span>
        </label>
        <button class="btn btn-primary" id="btn-m3u8-submit" style="margin-left: auto;">Queue Batch</button>
      </div>
    </div>
  `;

  document.getElementById('btn-m3u8-submit').onclick = () => {
    const urlsText = document.getElementById('m3u8-urls').value.trim();
    if (!urlsText) return toast.warning("Provide at least one URL.");
    
    const urls = urlsText.split('\n').map(u => u.trim()).filter(Boolean);
    const titlesText = document.getElementById('m3u8-titles').value.trim();
    const names = titlesText ? titlesText.split('\n').map(t => t.trim()).filter(Boolean) : null;
    const referer = document.getElementById('m3u8-referer').value.trim();

    const payload = {
      urls,
      names,
      referer: referer || null,
      use_scheduler: document.getElementById('m3u8-use-scheduler').checked
    };

    toast.info("Submitting batch request...");
    api.batchM3U8(payload).then(res => {
      toast.success(`Queued ${res.job_ids.length} jobs successfully!`);
      location.hash = '/';
    }).catch(err => toast.error(err.message));
  };
}

// Page: Settings & Sessions
function pageSettings(container) {
  container.innerHTML = `
    <div class="page-header">
      <h1 class="page-title">Settings & Sessions</h1>
      <p class="page-desc">Provision storage, delay timings, and platform access tokens</p>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 16px; font-weight: 600;">Global Settings</h3>
      <div class="form-group">
        <label class="label">Download Output Folder</label>
        <div style="display: flex; gap: 8px;">
          <input type="text" class="input" id="cfg-download-dir" style="flex: 1;" />
          <button class="btn btn-secondary" id="btn-browse-dir" style="padding: 0 16px; white-space: nowrap;">Browse...</button>
        </div>
      </div>
      <div class="form-group">
        <label class="label">Global Concurrency Limit</label>
        <input type="number" class="input" id="cfg-concurrency" />
      </div>
      <div class="form-group">
        <label class="label">Auto-Start Captures</label>
        <select class="input" id="cfg-auto-start">
          <option value="true">Download Immediately</option>
          <option value="false">Queue as Paused (Idle)</option>
        </select>
        <div class="hint" style="margin-top: 4px;">If disabled, newly intercepted videos will be added to the queue in a paused state.</div>
      </div>
      
      <button class="btn btn-primary" id="btn-save-settings" style="margin-top: 20px;">Save Configuration</button>
    </div>

    <div class="card">
      <h3 style="margin-bottom: 16px; font-weight: 600;">Active Platform Sessions</h3>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Cookie Count</th>
              <th>Token Loaded</th>
              <th>Config File</th>
            </tr>
          </thead>
          <tbody id="sessions-table-body">
            <tr><td colspan="4" class="empty-state">Loading sessions...</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  `;

  // Fetch settings
  api.getSettings().then(res => {
    const cfg = res.settings || {};
    
    let downloadDir = cfg.download_dir || 'downloads';
    if ((downloadDir.startsWith('"') && downloadDir.endsWith('"')) || (downloadDir.startsWith("'") && downloadDir.endsWith("'"))) {
      downloadDir = downloadDir.substring(1, downloadDir.length - 1);
    }
    
    document.getElementById('cfg-download-dir').value = downloadDir;
    document.getElementById('cfg-concurrency').value = cfg.global_max_concurrent || '8';
    document.getElementById('cfg-auto-start').value = cfg.auto_start_downloads || 'true';
  }).catch(() => {});

  // Fetch sessions
  api.getSessions().then(res => {
    const body = document.getElementById('sessions-table-body');
    if (res.sessions && res.sessions.length > 0) {
      body.innerHTML = res.sessions.map(s => `
        <tr>
          <td style="text-transform: capitalize; font-weight: 600;">${s.platform}</td>
          <td>${s.cookies_count}</td>
          <td>${s.has_token ? '✅ Yes' : '❌ No'}</td>
          <td><code>${s.file}</code></td>
        </tr>
      `).join('');
    } else {
      body.innerHTML = '<tr><td colspan="4" class="empty-state">No sessions captured. Use the extension to log in.</td></tr>';
    }
  }).catch(() => {});

  document.getElementById('btn-save-settings').onclick = () => {
    const payload = {
      settings: {
        download_dir: document.getElementById('cfg-download-dir').value.trim(),
        global_max_concurrent: document.getElementById('cfg-concurrency').value.trim(),
        auto_start_downloads: document.getElementById('cfg-auto-start').value
      }
    };

    api.updateSettings(payload).then(() => {
      toast.success("Settings updated successfully!");
    }).catch(err => toast.error(err.message));
  };

  const btnBrowse = document.getElementById('btn-browse-dir');
  if (btnBrowse) {
    btnBrowse.onclick = (e) => {
      e.preventDefault();
      if (window.pywebview && window.pywebview.api) {
        window.pywebview.api.select_folder().then(path => {
          if (path) document.getElementById('cfg-download-dir').value = path;
        });
      } else {
        fetch('/api/settings/browse-folder', { method: 'POST' })
          .then(r => r.json())
          .then(res => {
            if (res.path) {
              document.getElementById('cfg-download-dir').value = res.path;
            }
          })
          .catch(err => {
            toast.error("Could not trigger folder picker. Make sure Thunder GUI is active.");
          });
      }
    };
  }
}

// ── Routing Engine ────────────────────────────────────────────────────────
const routes = {
  '/': pageOverview,
  '/har': pageHAR,
  '/yanfaa': pageYanfaa,
  '/m3u8': pageM3U8,
  '/settings': pageSettings,
};

function handleRoute() {
  const hash = window.location.hash.slice(1) || '/';
  const renderFn = routes[hash];
  const mainContainer = document.getElementById('main');
  
  if (renderFn && mainContainer) {
    renderSidebar(hash);
    mainContainer.innerHTML = '';
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    mainContainer.appendChild(pageEl);
    renderFn(pageEl);
  }
}

// ── Initialize App ────────────────────────────────────────────────────────
window.addEventListener('hashchange', handleRoute);
document.addEventListener('DOMContentLoaded', () => {
  handleRoute();
  startJobPolling();
});
