// Inline File Monitor Panel as a component
// Exposed as window.initFileMonitorPanel(rootElement)

(function () {
  let connection_id = null;
  let repo_name = null;
  let timeline = [];
  let filteredTimeline = [];
  let ws = null;
  let isMiniMode = false;

  // Hover preview state
  let diffPreviewEl = null;
  let diffHideTimeout = null;

  // Selection state for multi-diff / compare
  const selectedSnapshots = new Set();
  let lastSelectedIndex = null;   // <--- add this


  const filters = {
    search: '',
    changeType: ''
  };

  function initFileMonitorPanel(root) {
    // Mark root and inject HTML
    root.classList.add('file-monitor-root');
    root.innerHTML = `
      <div class="monitor-container" id="fileMonitorContainer">
        <!-- Header -->
        <div class="monitor-header">
          <div class="header-row">
            <span class="status-indicator status-connecting" id="wsStatus"></span>
            <select class="repo-selector" id="repoSelector">
              <option value="">Loading...</option>
            </select>
            <button class="mini-toggle" id="miniToggleBtn">⚡</button>
          </div>
          <div class="header-row">
            <input type="text" class="search-box" id="searchBox" placeholder="🔍 Search files...">
            <select class="filter-select" id="changeTypeFilter">
              <option value="">All Changes</option>
              <option value="created">➕ Created</option>
              <option value="modified">✏️ Modified</option>
              <option value="deleted">🗑️ Deleted</option>
            </select>
          </div>
        </div>

        <!-- Selection bar -->
        <div class="selection-bar" id="selectionBar">
          <span id="selectionCount">0 selected</span>
          <button id="multiDiffBtn" disabled>Multi-file diff</button>
          <button id="compareBtn" disabled>Compare 2 snapshots</button>
          <button id="clearSelectionBtn">Clear</button>
        </div>

        <!-- Timeline -->
        <div class="timeline-list" id="timelineList">
          <div class="loading">
            <div class="spinner"></div>
          </div>
        </div>

        <!-- Mini Mode -->
        <div class="mini-mode">
          <div class="mini-badge" id="miniBadge">
            📁
            <span class="mini-count" id="miniCount">0</span>
          </div>
          <div class="mini-label">File Monitor</div>
          <button class="mini-expand" id="miniExpandBtn">Expand</button>
        </div>

        <!-- Multi-diff / compare modal -->
        <div class="fm-modal" id="multiDiffModal">
          <div class="fm-modal-content">
            <div class="fm-modal-header">
              <div class="fm-modal-title" id="multiDiffTitle">Diff</div>
              <button class="fm-modal-close" id="multiDiffCloseBtn">×</button>
            </div>
            <div class="fm-modal-body" id="multiDiffBody"></div>
          </div>
        </div>
      </div>
    `;

    // Wire events & fetch data
    setupEventListeners(root);
    loadRepositories();
  }

  function setupEventListeners(root) {
    const repoSelector = root.querySelector('#repoSelector');
    const searchBox = root.querySelector('#searchBox');
    const changeTypeFilter = root.querySelector('#changeTypeFilter');
    const miniToggleBtn = root.querySelector('#miniToggleBtn');
    const miniBadge = root.querySelector('#miniBadge');
    const miniExpandBtn = root.querySelector('#miniExpandBtn');

    const selectionBar = root.querySelector('#selectionBar');
    const multiDiffBtn = root.querySelector('#multiDiffBtn');
    const compareBtn = root.querySelector('#compareBtn');
    const clearSelectionBtn = root.querySelector('#clearSelectionBtn');

    const multiDiffModal = root.querySelector('#multiDiffModal');
    const multiDiffCloseBtn = root.querySelector('#multiDiffCloseBtn');

    repoSelector.addEventListener('change', (e) => {
      if (!e.target.value) return;
      const [conn, repo] = e.target.value.split(':');
      switchRepository(conn, repo);
    });

    searchBox.addEventListener('input', (e) => {
      filters.search = e.target.value.toLowerCase();
      applyFilters();
    });

    changeTypeFilter.addEventListener('change', (e) => {
      filters.changeType = e.target.value;
      applyFilters();
    });

    miniToggleBtn.addEventListener('click', () => toggleMiniMode());
    miniBadge.addEventListener('click', () => toggleMiniMode());
    miniExpandBtn.addEventListener('click', () => toggleMiniMode());

    // Selection bar actions
    multiDiffBtn.addEventListener('click', () => openMultiDiffFromSelection());
    compareBtn.addEventListener('click', () => compareSelectedSnapshots());
    clearSelectionBtn.addEventListener('click', () => clearSelection());

    // Modal events
    multiDiffCloseBtn.addEventListener('click', () => closeMultiDiffModal());
    multiDiffModal.addEventListener('click', (e) => {
      if (e.target === multiDiffModal) closeMultiDiffModal();
    });

    // ESC closes modal
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeMultiDiffModal();
    });
  }

  async function loadRepositories() {
    try {
      const response = await fetch('/api/v1/file-watcher/api/repositories');
      const repos = await response.json();

      const selector = document.getElementById('repoSelector');
      if (!selector) return;

      selector.innerHTML = '';

      if (!Array.isArray(repos) || repos.length === 0) {
        selector.innerHTML = '<option value="">No repositories</option>';
        return;
      }

      repos.forEach(repo => {
        const option = document.createElement('option');
        option.value = `${repo.connection_id}:${repo.repo_name}`;
        option.textContent = `${repo.connection_id}/${repo.repo_name}`;
        selector.appendChild(option);
      });

      // Auto-select first
      const firstRepo = repos[0];
      connection_id = firstRepo.connection_id;
      repo_name = firstRepo.repo_name;
      selector.value = `${connection_id}:${repo_name}`;
      await loadTimeline();
      connectWebSocket();

    } catch (error) {
      console.error('Error loading repositories:', error);
    }
  }

  function switchRepository(conn, repo) {
    connection_id = conn;
    repo_name = repo;
    timeline = [];
    filteredTimeline = [];
    selectedSnapshots.clear();
    updateSelectionBar();

    if (ws) ws.close();
    loadTimeline();
    connectWebSocket();
  }

  async function loadTimeline() {
    if (!connection_id || !repo_name) return;

    try {
      const response = await fetch(`/api/v1/file-watcher/api/timeline/${connection_id}/${repo_name}`);
      const data = await response.json();

      timeline = (data.snapshots || []).slice(0, 300); // Limit to 300
      applyFilters();

    } catch (error) {
      console.error('Error loading timeline:', error);
      renderError();
    }
  }

  function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/file-watcher-ws`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        updateStatus('connected');
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            connection_id,
            repo_name
          }));
        }, 100);
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'batch') {
          addBatchToTimeline(data.data);
        } else if (data.type === 'snapshot') {
          addBatchToTimeline({ snapshots: [data.data] });
        }
      };

      ws.onerror = () => updateStatus('error');
      ws.onclose = () => {
        updateStatus('disconnected');
        setTimeout(() => connectWebSocket(), 5000);
      };

    } catch (error) {
      console.error('WebSocket error:', error);
      updateStatus('error');
    }
  }

  function updateStatus(status) {
    const indicator = document.getElementById('wsStatus');
    if (!indicator) return;
    indicator.className = 'status-indicator';
    indicator.classList.add(`status-${status}`);
  }

  function addBatchToTimeline(batch) {
    if (batch.snapshots && batch.snapshots.length > 0) {
      batch.snapshots.forEach(snapshot => {
        timeline.unshift(snapshot);
      });

      // Keep only last 300
      timeline = timeline.slice(0, 300);
      applyFilters();
    }
  }

  function applyFilters() {
    filteredTimeline = timeline.filter(snapshot => {
      if (filters.search && !snapshot.file_path.toLowerCase().includes(filters.search)) {
        return false;
      }
      if (filters.changeType && snapshot.change_type !== filters.changeType) {
        return false;
      }
      return true;
    });

    renderTimeline();
    updateMiniCount();
  }

  function renderTimeline() {
    const container = document.getElementById('timelineList');
    if (!container) return;

    if (filteredTimeline.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <div>No changes found</div>
        </div>
      `;
      return;
    }

    const batches = groupByBatch(filteredTimeline);

    let html = '';
    batches.forEach(batch => {
      html += renderBatch(batch);
    });

    container.innerHTML = html;

    // Attach behaviors
    attachHoverPreview();
    attachSelectionHandlers();
  }

  function groupByBatch(snapshots) {
    const batchMap = new Map();

    snapshots.forEach(snapshot => {
      const batchId = snapshot.batch_id || `single_${snapshot.id}`;

      if (!batchMap.has(batchId)) {
        batchMap.set(batchId, {
          id: batchId,
          created_at: snapshot.created_at,
          source_type: snapshot.source_type,
          source_operation: snapshot.source_operation,
          snapshots: []
        });
      }

      batchMap.get(batchId).snapshots.push(snapshot);
    });

    return Array.from(batchMap.values()).sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    );
  }

  function renderBatch(batch) {
    const icon = getSourceIcon(batch.source_type);
    const time = formatTime(batch.created_at);
    const fileCount = batch.snapshots.length;
    const isMultiple = fileCount > 1;

    if (!isMultiple) {
      return renderFileItem(batch.snapshots[0]);
    }

    let html = `
      <div class="batch-group" id="batch-${batch.id}">
        <div class="batch-header" onclick="toggleBatch('${batch.id}')">
          <span class="batch-toggle">▶</span>
          <span class="batch-icon">${icon}</span>
          <div class="batch-info">
            <div class="batch-title">${batch.source_operation || batch.source_type || 'Changes'}</div>
            <div class="batch-meta">${fileCount} files • ${time}</div>
          </div>
        </div>
        <div class="batch-files">
    `;

    batch.snapshots.forEach(snapshot => {
      html += renderFileItem(snapshot);
    });

    html += `
        </div>
      </div>
    `;

    return html;
  }

  function renderFileItem(snapshot) {
    const icon = getChangeIcon(snapshot.change_type);
    const className = `change-${snapshot.change_type}`;
    const timeExact = formatExactTime(snapshot.created_at);
    const timeRelative = formatTime(snapshot.created_at);

    const fullPath = snapshot.file_path || '';
    const lastSlash = fullPath.lastIndexOf('/');
    const dirPath = lastSlash !== -1 ? fullPath.slice(0, lastSlash + 1) : '';
    const baseName = lastSlash !== -1 ? fullPath.slice(lastSlash + 1) : fullPath;

    const diff = getSnapshotDiff(snapshot);
    const stats = getDiffStats(diff);

    return `
      <div class="file-item ${className}" data-snapshot-id="${snapshot.id}">
        <span class="change-icon">${icon}</span>

        <div class="file-timestamp">${timeExact}</div>

        <div class="file-info">
          <div class="file-name" title="${escapeHtml(fullPath)}">
            ${
              dirPath
                ? `<span class="file-path-dir">${escapeHtml(dirPath)}</span>`
                : ''
            }
            <span class="file-path-base">${escapeHtml(baseName)}</span>
          </div>
          <div class="file-time">${timeRelative}</div>
        </div>

        <div class="file-actions">
          <span class="file-metrics">+${stats.added} / -${stats.removed}</span>
        </div>
      </div>
    `;
  }


  // Expose a couple of helpers globally because they're used inline in HTML
  window.toggleBatch = function (batchId) {
    const batch = document.getElementById(`batch-${batchId}`);
    if (batch) {
      batch.classList.toggle('expanded');
    }
  };

  window.openDiff = function (snapshotId, filePath) {
    // We are in the top window; use postMessage so framework handler can open a diff tab
    window.postMessage({
      type: 'OPEN_DIFF_TAB',
      snapshotId: snapshotId,
      filePath: filePath,
      connection_id: connection_id,
      repo_name: repo_name
    }, '*');
  };

  // Old backend restore is kept for now but not used by new hover buttons
  window.restoreFile = async function (snapshotId) {
    if (!confirm('Restore this file version?')) return;

    try {
      const response = await fetch(
        `/api/v1/file-watcher/api/file-watcher/restore/${snapshotId}`,
        { method: 'POST' }
      );

      const result = await response.json();
      if (result.success) {
        alert('File restored successfully');
      } else {
        alert('Failed to restore: ' + result.error);
      }
    } catch (error) {
      console.error('Error restoring file:', error);
      alert('Failed to restore file');
    }
  };

  function toggleMiniMode() {
    isMiniMode = !isMiniMode;
    const container = document.getElementById('fileMonitorContainer');
    if (container) {
      container.classList.toggle('mini', isMiniMode);
    }
    if (isMiniMode) {
      hideDiffPreview();
    }
  }

  function updateMiniCount() {
    const miniCountEl = document.getElementById('miniCount');
    if (miniCountEl) {
      miniCountEl.textContent = filteredTimeline.length;
    }
  }

  function renderError() {
    const list = document.getElementById('timelineList');
    if (!list) return;
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⚠️</div>
        <div>Failed to load timeline</div>
      </div>
    `;
  }

  function getChangeIcon(changeType) {
    const icons = {
      'created': '➕',
      'modified': '✏️',
      'deleted': '🗑️'
    };
    return icons[changeType] || '📝';
  }

  function getSourceIcon(sourceType) {
    const icons = {
      'git': '🔀',
      'editor': '📝',
      'ssh': '💻',
      'batch': '📦',
      'unknown': '❓'
    };
    return icons[sourceType] || '❓';
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return date.toLocaleDateString();
  }

  function formatExactTime(timestamp) {
    const date = new Date(timestamp);
    const pad = n => n.toString().padStart(2, '0');

    const year = date.getFullYear();
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const hours = pad(date.getHours());
    const minutes = pad(date.getMinutes());
    const seconds = pad(date.getSeconds());

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ====== Selection / multi-diff / compare helpers ======

  function attachSelectionHandlers() {
    const items = Array.from(document.querySelectorAll('.file-item'));

    items.forEach((item, index) => {
      const id = parseInt(item.dataset.snapshotId, 10);
      if (!id) return;

      // Single-click: selection logic (shift / ctrl / cmd)
      item.addEventListener('click', (e) => {
        handleItemClick(e, item, index, items);
      });

      // Double-click: open full diff tab
      item.addEventListener('dblclick', (e) => {
        handleItemDoubleClick(e, item);
      });
    });

    // Re-apply visual selection for already selected snapshots
    selectedSnapshots.forEach(id => {
      const el = document.querySelector(`.file-item[data-snapshot-id="${id}"]`);
      if (el) el.classList.add('selected');
    });
  }

  function handleItemClick(e, item, index, items) {
    const id = parseInt(item.dataset.snapshotId, 10);
    if (!id) return;

    // Shift-click → range selection
    if (e.shiftKey && lastSelectedIndex !== null && items[lastSelectedIndex]) {
      // If shift but no ctrl/cmd: clear existing selection first
      if (!e.ctrlKey && !e.metaKey) {
        selectedSnapshots.clear();
        items.forEach(el => el.classList.remove('selected'));
      }

      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);

      for (let i = start; i <= end; i++) {
        const el = items[i];
        const rowId = parseInt(el.dataset.snapshotId, 10);
        if (!rowId) continue;
        selectedSnapshots.add(rowId);
        el.classList.add('selected');
      }
    }
    // Ctrl/Cmd-click → toggle single row without clearing others
    else if (e.ctrlKey || e.metaKey) {
      if (selectedSnapshots.has(id)) {
        selectedSnapshots.delete(id);
        item.classList.remove('selected');
      } else {
        selectedSnapshots.add(id);
        item.classList.add('selected');
      }
    }
    // Plain click → single selection (clear all, then select this row)
    else {
      selectedSnapshots.clear();
      items.forEach(el => el.classList.remove('selected'));
      selectedSnapshots.add(id);
      item.classList.add('selected');
    }

    lastSelectedIndex = index;
    updateSelectionBar();
  }

  function handleItemDoubleClick(e, item) {
    e.preventDefault();
    e.stopPropagation();

    const id = parseInt(item.dataset.snapshotId, 10);
    if (!id) return;

    const snapshot = timeline.find(s => s.id === id);
    if (!snapshot) return;

    // Use existing openDiff helper to open full diff tab
    openDiff(snapshot.id, snapshot.file_path);
  }



  function updateSelectionBar() {
    const bar = document.getElementById('selectionBar');
    const countSpan = document.getElementById('selectionCount');
    const multiBtn = document.getElementById('multiDiffBtn');
    const compareBtn = document.getElementById('compareBtn');

    const count = selectedSnapshots.size;

    if (!bar || !countSpan || !multiBtn || !compareBtn) return;

    if (count === 0) {
      bar.style.display = 'none';
    } else {
      bar.style.display = 'flex';
    }

    countSpan.textContent = `${count} selected`;
    multiBtn.disabled = count === 0;
    compareBtn.disabled = count !== 2;
  }

  function clearSelection() {
    selectedSnapshots.clear();
    document.querySelectorAll('.file-item.selected').forEach(el => {
      el.classList.remove('selected');
    });
    lastSelectedIndex = null;    // <--- add this
    updateSelectionBar();
  }


  function openMultiDiffFromSelection() {
    if (selectedSnapshots.size === 0) {
      alert('Select at least one snapshot.');
      return;
    }

    const ids = Array.from(selectedSnapshots);
    const snaps = timeline.filter(s => ids.includes(s.id));

    if (snaps.length === 0) {
      alert('No snapshots found for selection.');
      return;
    }

    let html = '';
    snaps
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .forEach(s => {
        const diff = getSnapshotDiff(s);
        const stats = getDiffStats(diff);
        const header = `
          <div class="fm-multi-diff-header">
            <span>${escapeHtml(s.file_path)}</span>
            <span>${formatExactTime(s.created_at)}</span>
            <span>${s.change_type}</span>
            <span>+${stats.added} / -${stats.removed}</span>
          </div>
        `;
        html += `
          <div class="fm-multi-diff-section">
            ${header}
            ${renderFullDiff(diff)}
          </div>
        `;
      });

    openMultiDiffModal('Multi-file diff', html || '<div>No content</div>');
  }

  function compareSelectedSnapshots() {
    if (selectedSnapshots.size !== 2) {
      alert('Select exactly 2 snapshots to compare.');
      return;
    }

    const ids = Array.from(selectedSnapshots);
    const snaps = timeline.filter(s => ids.includes(s.id));

    if (snaps.length !== 2) {
      alert('Unable to resolve the selected snapshots.');
      return;
    }

    snaps.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const [older, newer] = snaps;

    const olderDiff = getSnapshotDiff(older);
    const newerDiff = getSnapshotDiff(newer);

    let html = '';

    html += `
      <div class="fm-multi-diff-section">
        <div class="fm-multi-diff-header">
          <span>Older: ${escapeHtml(older.file_path)}</span>
          <span>${formatExactTime(older.created_at)}</span>
          <span>${older.change_type}</span>
        </div>
        ${renderFullDiff(olderDiff)}
      </div>
    `;

    html += `
      <div class="fm-multi-diff-section">
        <div class="fm-multi-diff-header">
          <span>Newer: ${escapeHtml(newer.file_path)}</span>
          <span>${formatExactTime(newer.created_at)}</span>
          <span>${newer.change_type}</span>
        </div>
        ${renderFullDiff(newerDiff)}
      </div>
    `;

    openMultiDiffModal('Compare 2 snapshots (sequential view)', html);
  }

  function openMultiDiffModal(title, html) {
    const modal = document.getElementById('multiDiffModal');
    const body = document.getElementById('multiDiffBody');
    const titleEl = document.getElementById('multiDiffTitle');

    if (!modal || !body || !titleEl) return;

    titleEl.textContent = title;
    body.innerHTML = html || '<div>No content</div>';
    modal.style.display = 'flex';
  }

  function closeMultiDiffModal() {
    const modal = document.getElementById('multiDiffModal');
    if (modal) modal.style.display = 'none';
  }

  // ========== Diff helpers (parse, stats, full render) ==========

  function getSnapshotDiff(snapshot) {
    if (!snapshot) return null;
    if (snapshot._parsedDiff) return snapshot._parsedDiff;
    if (!snapshot.diff) return null;

    try {
      const diff = typeof snapshot.diff === 'string'
        ? JSON.parse(snapshot.diff)
        : snapshot.diff;
      snapshot._parsedDiff = diff;
      return diff;
    } catch (e) {
      console.error('Failed to parse diff for snapshot', snapshot.id, e);
      return null;
    }
  }

  function getDiffStats(diff) {
    // Structured format with hunks
    if (diff && Array.isArray(diff.hunks)) {
      let added = 0;
      let removed = 0;

      diff.hunks.forEach(hunk => {
        hunk.lines.forEach(line => {
          if (line.type === 'add') added++;
          if (line.type === 'del') removed++;
        });
      });

      return { added, removed };
    }

    // Unified format: { unified: "..." }
    if (diff && typeof diff.unified === 'string') {
      const lines = diff.unified.split('\n');
      let added = 0;
      let removed = 0;

      for (const line of lines) {
        // Skip headers
        if (
          line.startsWith('+++') ||
          line.startsWith('---') ||
          line.startsWith('Index:') ||
          line.startsWith('===') ||
          line.startsWith('@@')
        ) {
          continue;
        }
        if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }

      return { added, removed };
    }

    return { added: 0, removed: 0 };
  }

  function renderMiniDiff(diff) {
    // Full diff, scrolling controlled by CSS

    // Structured format with hunks
    if (diff && Array.isArray(diff.hunks)) {
      let html = '<div class="mini-diff">';

      diff.hunks.forEach(hunk => {
        if (hunk.header) {
          html += `<div class="diff-line hunk-header">${escapeHtml(hunk.header)}</div>`;
        }
        hunk.lines.forEach(line => {
          const lineClass =
            line.type === 'add' ? 'diff-add' :
            line.type === 'del' ? 'diff-del' : 'diff-context';
          const prefix =
            line.type === 'add' ? '+' :
            line.type === 'del' ? '-' : ' ';
          html += `<div class="diff-line ${lineClass}">${escapeHtml(prefix + line.content)}</div>`;
        });
      });

      html += '</div>';
      return html;
    }

    // Unified format: { unified: "..." }
    if (diff && typeof diff.unified === 'string') {
      const lines = diff.unified.split('\n');
      let html = '<div class="mini-diff">';

      for (const line of lines) {
        let className = 'diff-context';

        if (line.startsWith('+++') || line.startsWith('---')) {
          className = 'diff-context';
        } else if (line.startsWith('@@')) {
          className = 'hunk-header';
        } else if (line.startsWith('+')) {
          className = 'diff-add';
        } else if (line.startsWith('-')) {
          className = 'diff-del';
        }

        if (line.startsWith('Index:') || line.startsWith('===')) {
          continue;
        }

        html += `<div class="diff-line ${className}">${escapeHtml(line)}</div>`;
      }

      html += '</div>';
      return html;
    }

    return '<div class="mini-diff"><div class="diff-line diff-context">No diff data available</div></div>';
  }

  function renderFullDiff(diff) {
    if (!diff) {
      return '<div>No changes to display</div>';
    }

    // Unified format
    if (diff.unified) {
      const lines = diff.unified.split('\n');
      let html = '';

      lines.forEach(line => {
        let cls = 'fm-full-diff-context';
        if (line.startsWith('+++') || line.startsWith('---')) {
          cls = 'fm-full-diff-file-header';
        } else if (line.startsWith('@@')) {
          cls = 'fm-full-diff-hunk-header';
        } else if (line.startsWith('+')) {
          cls = 'fm-full-diff-add';
        } else if (line.startsWith('-')) {
          cls = 'fm-full-diff-del';
        } else if (line.startsWith('Index:') || line.startsWith('===')) {
          cls = 'fm-full-diff-index';
        }

        html += `<div class="fm-full-diff-line ${cls}">${escapeHtml(line)}</div>`;
      });

      return html;
    }

    // Structured hunks
    if (diff.hunks && diff.hunks.length > 0) {
      let html = '';
      diff.hunks.forEach(hunk => {
        if (hunk.header) {
          html += `<div class="fm-full-diff-line fm-full-diff-hunk-header">${escapeHtml(hunk.header)}</div>`;
        }
        hunk.lines.forEach(line => {
          const cls = line.type === 'add'
            ? 'fm-full-diff-add'
            : line.type === 'del'
            ? 'fm-full-diff-del'
            : 'fm-full-diff-context';
          const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          html += `<div class="fm-full-diff-line ${cls}">${escapeHtml(prefix + line.content)}</div>`;
        });
      });
      return html;
    }

    return '<div>No changes to display</div>';
  }

  function isRevertible(snapshot, diff) {
    if (!snapshot) return false;
    if (snapshot.change_type === 'deleted') return false;
    if (!diff) return false;
    return !!(diff.hunks && diff.hunks.length) || !!diff.unified;
  }

  function handleRestoreSnapshot(snapshot) {
    // Placeholder only (no backend yet)
    alert(`Restore snapshot requested for:\n${snapshot.file_path}\n\n(Backend not implemented yet.)`);
  }

  function handleRevertChange(snapshot) {
    // Placeholder only (no backend yet)
    alert(`Revert individual change requested for:\n${snapshot.file_path}\n\n(Backend not implemented yet.)`);
  }

  // ====== Hover diff preview helpers ======

  function attachHoverPreview() {
    const items = document.querySelectorAll('.file-item');
    items.forEach(item => {
      item.addEventListener('mouseenter', () => {
        const id = parseInt(item.dataset.snapshotId, 10);
        const snapshot = timeline.find(s => s.id === id);
        if (!snapshot) return;
        showDiffPreview(snapshot, item);
      });

      item.addEventListener('mouseleave', () => {
        scheduleHideDiffPreview();
      });
    });
  }

  function showDiffPreview(snapshot, anchorEl) {
    clearTimeout(diffHideTimeout);
    hideDiffPreview();

    const diff = getSnapshotDiff(snapshot);
    const stats = getDiffStats(diff);
    const createdAt = formatTime(snapshot.created_at);
    const revertible = isRevertible(snapshot, diff);

    const preview = document.createElement('div');
    preview.id = 'diff-preview';
    preview.className = 'diff-preview';

    const safePath = escapeHtml(snapshot.file_path);

    preview.innerHTML = `
      <div class="preview-actions">
        <button class="preview-btn-primary preview-btn-open" type="button">Full diff</button>
        <button class="preview-btn-restore-snapshot" type="button">Restore snapshot</button>
        ${revertible ? `<button class="preview-btn-revert-change" type="button">Revert change</button>` : ''}
        <button class="preview-btn-copy" type="button">Copy path</button>
      </div>
      <div class="preview-header" title="${safePath}">
        ${safePath}
      </div>
      <div class="preview-meta">
        <span>${snapshot.change_type || 'change'}</span>
        <span>${createdAt}</span>
      </div>
      <div class="preview-stats">
        <span class="stat-added">+${stats.added}</span>
        <span class="stat-removed">-${stats.removed}</span>
      </div>
      ${renderMiniDiff(diff)}
    `;

    document.body.appendChild(preview);
    diffPreviewEl = preview;

    // Width/height constraints
    preview.style.width = 'auto';
    preview.style.maxWidth = '1600px';
    preview.style.maxHeight = '700px';

    // Position panel
    const rect = anchorEl.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = preview.offsetWidth || 600;
    const panelHeight = preview.offsetHeight || 400;

    let left = rect.right + 10;
    if (left + panelWidth > viewportWidth - 10) {
      left = Math.max(10, rect.left - panelWidth - 10);
    }

    let top = rect.top;
    if (top + panelHeight > viewportHeight - 10) {
      top = Math.max(10, viewportHeight - panelHeight - 10);
    }

    preview.style.top = `${top}px`;
    preview.style.left = `${left}px`;

    // Keep alive on hover
    preview.addEventListener('mouseenter', () => {
      clearTimeout(diffHideTimeout);
    });
    preview.addEventListener('mouseleave', () => {
      scheduleHideDiffPreview();
    });

    // Buttons
    const openBtn = preview.querySelector('.preview-btn-open');
    if (openBtn) {
      openBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openDiff(snapshot.id, snapshot.file_path);
      });
    }

    const restoreSnapshotBtn = preview.querySelector('.preview-btn-restore-snapshot');
    if (restoreSnapshotBtn) {
      restoreSnapshotBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handleRestoreSnapshot(snapshot);
      });
    }

    const revertBtn = preview.querySelector('.preview-btn-revert-change');
    if (revertBtn) {
      revertBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        handleRevertChange(snapshot);
      });
    }

    const copyBtn = preview.querySelector('.preview-btn-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        try {
          navigator.clipboard.writeText(snapshot.file_path);
        } catch (e) {
          console.warn('Clipboard write failed', e);
        }
      });
    }
  }

  function scheduleHideDiffPreview() {
    clearTimeout(diffHideTimeout);
    diffHideTimeout = setTimeout(() => {
      hideDiffPreview();
    }, 150);
  }

  function hideDiffPreview() {
    if (diffPreviewEl) {
      diffPreviewEl.remove();
      diffPreviewEl = null;
    }
  }

  // Export the init function
  window.initFileMonitorPanel = initFileMonitorPanel;
})();
