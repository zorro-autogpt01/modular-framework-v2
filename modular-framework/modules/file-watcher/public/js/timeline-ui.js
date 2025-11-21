// File Watcher Timeline UI
class FileWatcherTimeline {
  constructor(connection_id = null, repo_name = null) {
    this.connection_id = connection_id;
    this.repo_name = repo_name;
    this.timeline = [];
    this.filteredTimeline = [];
    this.diffMode = 'unified';
    this.ws = null;
    this.reconnectInterval = null;

    // Filter state
    this.filters = {
      search: '',
      changeType: '',
      source: '',
      startDate: null,
      endDate: null
    };

    // Hover preview state
    this.diffPreviewEl = null;
    this.diffHideTimeout = null;

    this.init();
  }

  async init() {
    this.setupEventListeners();
    await this.loadRepositories();

    if (this.connection_id && this.repo_name) {
      await this.loadTimeline();
      this.connectWebSocket();
    }
  }

  async loadRepositories() {
    try {
      const response = await fetch('/api/repositories');
      const repos = await response.json();

      const selector = document.getElementById('repo-selector');
      selector.innerHTML = '';

      if (!Array.isArray(repos) || repos.length === 0) {
        selector.innerHTML = '<option value="">No repositories found</option>';
        return;
      }

      repos.forEach(repo => {
        const option = document.createElement('option');
        option.value = `${repo.connection_id}:${repo.repo_name}`;
        option.textContent = `${repo.connection_id}/${repo.repo_name}`;

        if (repo.connection_id === this.connection_id && repo.repo_name === this.repo_name) {
          option.selected = true;
        }

        selector.appendChild(option);
      });

      // Auto-select first repo if none specified
      if (!this.connection_id && !this.repo_name && repos.length > 0) {
        const firstRepo = repos[0];
        this.connection_id = firstRepo.connection_id;
        this.repo_name = firstRepo.repo_name;
        selector.value = `${this.connection_id}:${this.repo_name}`;
        await this.loadTimeline();
        this.connectWebSocket();
      }

    } catch (error) {
      console.error('Error loading repositories:', error);
      this.showToast('Failed to load repositories', 'error');
    }
  }

  setupEventListeners() {
    // Repository selector
    document.getElementById('repo-selector').addEventListener('change', (e) => {
      if (!e.target.value) return;

      const [connection_id, repo_name] = e.target.value.split(':');
      this.switchRepository(connection_id, repo_name);
    });

    // Search
    document.getElementById('timeline-search').addEventListener('input', (e) => {
      this.filters.search = e.target.value.toLowerCase();
      this.applyFilters();
    });

    // Change type filter
    document.getElementById('change-type-filter').addEventListener('change', (e) => {
      this.filters.changeType = e.target.value;
      this.applyFilters();
    });

    // Source filter
    document.getElementById('timeline-source-filter').addEventListener('change', (e) => {
      this.filters.source = e.target.value;
      this.applyFilters();
    });

    // Date filters
    document.getElementById('timeline-start-date').addEventListener('change', (e) => {
      this.filters.startDate = e.target.value ? new Date(e.target.value) : null;
      this.applyFilters();
    });

    document.getElementById('timeline-end-date').addEventListener('change', (e) => {
      this.filters.endDate = e.target.value ? new Date(e.target.value) : null;
      this.applyFilters();
    });

    // Diff mode
    document.getElementById('diff-mode-selector').addEventListener('change', (e) => {
      this.diffMode = e.target.value;
    });

    // Clear timeline
    document.getElementById('clear-timeline-btn').addEventListener('click', () => {
      this.clearTimeline();
    });
  }

  switchRepository(connection_id, repo_name) {
    this.connection_id = connection_id;
    this.repo_name = repo_name;

    // Update URL
    const newUrl = `/timeline/${connection_id}/${repo_name}`;
    window.history.pushState({}, '', newUrl);

    // Disconnect old WebSocket
    if (this.ws) {
      this.ws.close();
    }

    // Load new timeline
    this.timeline = [];
    this.filteredTimeline = [];
    this.loadTimeline();
    this.connectWebSocket();
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/file-watcher-ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('WebSocket connected');
        this.updateConnectionStatus('connected');

        // Wait a bit for connection to be fully ready
        setTimeout(() => {
          this.ws.send(JSON.stringify({
            type: 'subscribe',
            connection_id: this.connection_id,
            repo_name: this.repo_name
          }));
        }, 100);
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleWebSocketMessage(data);
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        this.updateConnectionStatus('error');
      };

      this.ws.onclose = () => {
        console.log('WebSocket disconnected');
        this.updateConnectionStatus('disconnected');

        // Attempt reconnect after 5 seconds
        if (this.reconnectInterval) {
          clearTimeout(this.reconnectInterval);
        }
        this.reconnectInterval = setTimeout(() => {
          this.connectWebSocket();
        }, 5000);
      };

    } catch (error) {
      console.error('Failed to connect WebSocket:', error);
      this.updateConnectionStatus('error');
    }
  }

  handleWebSocketMessage(data) {
    if (data.type === 'subscribed') {
      console.log('Subscribed to updates');
      this.showToast('Connected to real-time updates', 'success');
    } else if (data.type === 'batch') {
      console.log('Received batch update:', data.data);
      this.addBatchToTimeline(data.data);
    } else if (data.type === 'snapshot') {
      console.log('Received snapshot update:', data.data);
      this.addSnapshotToTimeline(data.data);
    }
  }

  addBatchToTimeline(batch) {
    // Add snapshots from batch to timeline
    if (batch.snapshots && batch.snapshots.length > 0) {
      batch.snapshots.forEach(snapshot => {
        this.timeline.unshift(snapshot);
      });

      this.applyFilters();
      this.showToast(`${batch.snapshots.length} file(s) updated`, 'info');
    }
  }

  addSnapshotToTimeline(snapshot) {
    this.timeline.unshift(snapshot);
    this.applyFilters();
    this.showToast('File updated', 'info');
  }

  updateConnectionStatus(status) {
    const statusIndicator = document.getElementById('ws-status');
    const statusText = document.getElementById('ws-status-text');

    statusIndicator.className = 'status-indicator';

    switch (status) {
      case 'connected':
        statusIndicator.classList.add('status-connected');
        statusText.textContent = 'Connected';
        break;
      case 'disconnected':
        statusIndicator.classList.add('status-disconnected');
        statusText.textContent = 'Disconnected';
        break;
      case 'connecting':
        statusIndicator.classList.add('status-connecting');
        statusText.textContent = 'Connecting...';
        break;
      case 'error':
        statusIndicator.classList.add('status-error');
        statusText.textContent = 'Connection Error';
        break;
    }
  }

  async loadTimeline() {
    if (!this.connection_id || !this.repo_name) {
      return;
    }

    try {
      const response = await fetch(`/api/timeline/${this.connection_id}/${this.repo_name}`);
      const data = await response.json();

      this.timeline = data.snapshots || [];
      this.applyFilters();

    } catch (error) {
      console.error('Error loading timeline:', error);
      this.showToast('Failed to load timeline', 'error');
      this.renderError('Failed to load timeline');
    }
  }

  applyFilters() {
    this.filteredTimeline = this.timeline.filter(snapshot => {
      // Search filter
      if (this.filters.search && !snapshot.file_path.toLowerCase().includes(this.filters.search)) {
        return false;
      }

      // Change type filter
      if (this.filters.changeType && snapshot.change_type !== this.filters.changeType) {
        return false;
      }

      // Source filter
      if (this.filters.source && snapshot.source_type !== this.filters.source) {
        return false;
      }

      // Date range filter
      const snapshotDate = new Date(snapshot.created_at);
      if (this.filters.startDate && snapshotDate < this.filters.startDate) {
        return false;
      }
      if (this.filters.endDate && snapshotDate > this.filters.endDate) {
        return false;
      }

      return true;
    });

    this.renderTimeline();
  }

  renderTimeline() {
    const container = document.getElementById('timeline-container');

    if (this.filteredTimeline.length === 0) {
      container.innerHTML = `
        <div class="timeline-empty">
          <div class="empty-icon">📭</div>
          <div class="empty-text">No file changes found</div>
          <div class="empty-subtext">
            ${this.timeline.length > 0 ? 'Try adjusting your filters' : 'Make some changes to see them here'}
          </div>
        </div>
      `;
      return;
    }

    // Group by batch
    const batches = this.groupByBatch(this.filteredTimeline);

    let html = '<div class="timeline-list">';

    batches.forEach(batch => {
      html += this.renderBatch(batch);
    });

    html += '</div>';
    container.innerHTML = html;

    // Attach event listeners (including hover preview)
    this.attachTimelineEventListeners();
  }

  groupByBatch(snapshots) {
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

  renderBatch(batch) {
    const timestamp = this.formatTimestamp(batch.created_at);
    const sourceIcon = this.getSourceIcon(batch.source_type);
    const fileCount = batch.snapshots.length;

    let html = `
      <div class="timeline-batch">
        <div class="batch-header">
          <div class="batch-info">
            <span class="batch-icon">${sourceIcon}</span>
            <span class="batch-source">${batch.source_operation || batch.source_type || 'Unknown'}</span>
            <span class="batch-files">${fileCount} file${fileCount !== 1 ? 's' : ''}</span>
          </div>
          <div class="batch-time">${timestamp}</div>
        </div>
        <div class="batch-snapshots">
    `;

    batch.snapshots.forEach(snapshot => {
      html += this.renderSnapshot(snapshot);
    });

    html += `
        </div>
      </div>
    `;

    return html;
  }

  renderSnapshot(snapshot) {
    const changeIcon = this.getChangeIcon(snapshot.change_type);
    const changeClass = `change-${snapshot.change_type}`;

    return `
      <div class="timeline-item ${changeClass}" data-snapshot-id="${snapshot.id}">
        <div class="item-header">
          <span class="change-icon">${changeIcon}</span>
          <span class="file-path">${snapshot.file_path}</span>
          <span class="change-type">${snapshot.change_type}</span>
        </div>
        <div class="item-actions">
          <button class="btn-secondary btn-small" onclick="timelineUI.viewDiff(${snapshot.id})">
            View Diff
          </button>
          <button class="btn-secondary btn-small" onclick="timelineUI.viewHistory('${snapshot.file_path}')">
            History
          </button>
          ${snapshot.change_type !== 'deleted' ? `
            <button class="btn-primary btn-small" onclick="timelineUI.restoreFile(${snapshot.id})">
              Restore
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  attachTimelineEventListeners() {
    // Add hover preview
    const items = document.querySelectorAll('.timeline-item');
    items.forEach(item => {
      item.addEventListener('mouseenter', (e) => {
        const snapshotId = parseInt(e.currentTarget.dataset.snapshotId, 10);
        this.showDiffPreview(snapshotId, e.currentTarget);
      });

      item.addEventListener('mouseleave', () => {
        this.scheduleHideDiffPreview();
      });
    });
  }

  getDiffForSnapshot(snapshot) {
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

  showDiffPreview(snapshotId, element) {
    const snapshot = this.timeline.find(s => s.id === snapshotId);
    if (!snapshot) return;

    clearTimeout(this.diffHideTimeout);
    this.hideDiffPreview();

    const diff = this.getDiffForSnapshot(snapshot);
    const stats = this.getDiffStats(diff);
    const timestamp = this.formatTimestamp(snapshot.created_at);

    // Create preview tooltip
    const preview = document.createElement('div');
    preview.id = 'diff-preview';
    preview.className = 'diff-preview';

    const escapedPath = this.escapeHtml(snapshot.file_path);

    preview.innerHTML = `
      <div class="preview-header" title="${escapedPath}">${escapedPath}</div>
      <div class="preview-meta">
        <span>${snapshot.change_type || 'change'}</span>
        <span>${timestamp}</span>
      </div>
      <div class="preview-stats">
        <span class="stat-added">+${stats.added}</span>
        <span class="stat-removed">-${stats.removed}</span>
      </div>
      ${this.renderMiniDiff(diff)}
      <div class="preview-actions">
        <button type="button" class="preview-btn-copy">Copy path</button>
        ${snapshot.change_type !== 'deleted' ? `
          <button type="button" class="preview-btn-restore">Restore</button>
        ` : ''}
        <button type="button" class="preview-btn-primary preview-btn-view">Full diff</button>
      </div>
    `;

    document.body.appendChild(preview);
    this.diffPreviewEl = preview;

    // Position tooltip
    const rect = element.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const panelWidth = preview.offsetWidth || 380;
    let left = rect.right + 10;
    if (left + panelWidth > viewportWidth - 10) {
      left = Math.max(10, rect.left - panelWidth - 10);
    }
    preview.style.top = `${rect.top}px`;
    preview.style.left = `${left}px`;

    // Keep panel alive on hover
    preview.addEventListener('mouseenter', () => {
      clearTimeout(this.diffHideTimeout);
    });
    preview.addEventListener('mouseleave', () => {
      this.scheduleHideDiffPreview();
    });

    // Wire actions
    const viewBtn = preview.querySelector('.preview-btn-view');
    if (viewBtn) {
      viewBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.viewDiff(snapshot.id);
      });
    }

    const restoreBtn = preview.querySelector('.preview-btn-restore');
    if (restoreBtn) {
      restoreBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await this.restoreFile(snapshot.id);
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

  scheduleHideDiffPreview() {
    clearTimeout(this.diffHideTimeout);
    this.diffHideTimeout = setTimeout(() => {
      this.hideDiffPreview();
    }, 150);
  }

  hideDiffPreview() {
    if (this.diffPreviewEl) {
      this.diffPreviewEl.remove();
      this.diffPreviewEl = null;
    }
  }

  renderMiniDiff(diff) {
  // Structured format with hunks
  if (diff && Array.isArray(diff.hunks)) {
    let html = '<div class="mini-diff">';
    const maxLines = 12;
    let lineCount = 0;

    for (const hunk of diff.hunks) {
      if (lineCount >= maxLines) break;

      for (const line of hunk.lines) {
        if (lineCount >= maxLines) break;

        const lineClass =
          line.type === 'add' ? 'add' :
          line.type === 'del' ? 'del' : 'context';
        const prefix =
          line.type === 'add' ? '+' :
          line.type === 'del' ? '-' : ' ';
        html += `<div class="diff-line diff-${lineClass}">${this.escapeHtml(prefix + line.content)}</div>`;
        lineCount++;
      }
    }

    if (lineCount >= maxLines) {
      html += '<div class="diff-more">...</div>';
    }

    html += '</div>';
    return html;
  }

  // Unified format: { unified: "..." }
  if (diff && typeof diff.unified === 'string') {
    const lines = diff.unified.split('\n');
    let html = '<div class="mini-diff">';
    const maxLines = 12;
    let lineCount = 0;

    for (const line of lines) {
      if (lineCount >= maxLines) break;

      let className = 'diff-context';

      if (line.startsWith('+++') || line.startsWith('---') ||
          line.startsWith('Index:') || line.startsWith('===')) {
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

      html += `<div class="diff-line ${className}">${this.escapeHtml(line)}</div>`;
      lineCount++;
    }

    if (lineCount >= maxLines) {
      html += '<div class="diff-more">...</div>';
    }

    html += '</div>';
    return html;
  }

  return '<div class="mini-diff"><div class="diff-line diff-context">No diff data available</div></div>';
}

  getDiffStats(diff) {
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

  viewDiff(snapshotId) {
    const snapshot = this.timeline.find(s => s.id === snapshotId);
    if (!snapshot) return;

    const modal = document.getElementById('diff-modal');
    const modalTitle = document.getElementById('diff-modal-title');
    const modalContent = document.getElementById('diff-modal-content');

    modalTitle.textContent = `Diff: ${snapshot.file_path}`;

    const diff = this.getDiffForSnapshot(snapshot);
    modalContent.innerHTML = this.renderFullDiff(diff);

    modal.style.display = 'block';
  }

  renderFullDiff(diff) {
    console.log('Rendering diff:', diff);

    if (!diff) {
      return '<div class="no-diff">No changes to display</div>';
    }

    // Handle unified diff format (string)
    if (diff.unified) {
      const lines = diff.unified.split('\n');
      let html = '<div class="full-diff"><div class="diff-unified">';

      lines.forEach(line => {
        let className = 'diff-context';
        if (line.startsWith('+++') || line.startsWith('---')) {
          className = 'diff-file-header';
        } else if (line.startsWith('@@')) {
          className = 'hunk-header';
        } else if (line.startsWith('+')) {
          className = 'diff-add';
        } else if (line.startsWith('-')) {
          className = 'diff-del';
        } else if (line.startsWith('Index:') || line.startsWith('===')) {
          className = 'diff-index';
        }

        html += `<div class="diff-line ${className}">${this.escapeHtml(line)}</div>`;
      });

      html += '</div></div>';
      return html;
    }

    // Handle hunks format (structured)
    if (diff.hunks && diff.hunks.length > 0) {
      let html = '<div class="full-diff">';

      diff.hunks.forEach(hunk => {
        html += `<div class="diff-hunk">`;
        html += `<div class="hunk-header">${this.escapeHtml(hunk.header)}</div>`;

        hunk.lines.forEach(line => {
          const lineClass = line.type === 'add' ? 'add' : line.type === 'del' ? 'del' : 'context';
          const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
          html += `<div class="diff-line diff-${lineClass}">`;
          html += `<span class="line-prefix">${prefix}</span>`;
          html += `<span class="line-content">${this.escapeHtml(line.content)}</span>`;
          html += `</div>`;
        });

        html += `</div>`;
      });

      html += '</div>';
      return html;
    }

    return '<div class="no-diff">No changes to display</div>';
  }

  async viewHistory(filePath) {
    const modal = document.getElementById('history-modal');
    const modalTitle = document.getElementById('history-modal-title');
    const modalContent = document.getElementById('history-modal-content');

    modalTitle.textContent = `History: ${filePath}`;
    modalContent.innerHTML = '<div class="loading-spinner"></div>';

    modal.style.display = 'block';

    try {
      const response = await fetch(`/api/timeline/${this.connection_id}/${this.repo_name}/${encodeURIComponent(filePath)}`);
      const data = await response.json();

      if (data.history && data.history.length > 0) {
        modalContent.innerHTML = this.renderHistory(data.history);
      } else {
        modalContent.innerHTML = '<div class="no-history">No history found</div>';
      }

    } catch (error) {
      console.error('Error loading history:', error);
      modalContent.innerHTML = '<div class="error">Failed to load history</div>';
    }
  }

  renderHistory(history) {
    let html = '<div class="history-list">';

    history.forEach((snapshot) => {
      const timestamp = this.formatTimestamp(snapshot.created_at);
      const changeIcon = this.getChangeIcon(snapshot.change_type);

      html += `
        <div class="history-item">
          <div class="history-header">
            <span class="change-icon">${changeIcon}</span>
            <span class="change-type">${snapshot.change_type}</span>
            <span class="history-time">${timestamp}</span>
          </div>
          <div class="history-actions">
            <button class="btn-secondary btn-small" onclick="timelineUI.viewDiff(${snapshot.id})">
              View Diff
            </button>
            ${snapshot.change_type !== 'deleted' ? `
              <button class="btn-primary btn-small" onclick="timelineUI.restoreFile(${snapshot.id})">
                Restore
              </button>
            ` : ''}
          </div>
        </div>
      `;
    });

    html += '</div>';
    return html;
  }

  async restoreFile(snapshotId) {
    if (!confirm('Are you sure you want to restore this file version?')) {
      return;
    }

    try {
      const response = await fetch(`/api/file-watcher/restore/${snapshotId}`, {
        method: 'POST'
      });

      const result = await response.json();

      if (result.success) {
        this.showToast('File restored successfully', 'success');
      } else {
        this.showToast('Failed to restore file: ' + result.error, 'error');
      }

    } catch (error) {
      console.error('Error restoring file:', error);
      this.showToast('Failed to restore file', 'error');
    }
  }

  async clearTimeline() {
    if (!confirm('Are you sure you want to clear the entire timeline? This cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(`/api/file-watcher/clear/${this.connection_id}/${this.repo_name}`, {
        method: 'DELETE'
      });

      const result = await response.json();

      if (result.success) {
        this.timeline = [];
        this.filteredTimeline = [];
        this.renderTimeline();
        this.showToast('Timeline cleared', 'success');
      } else {
        this.showToast('Failed to clear timeline: ' + result.error, 'error');
      }

    } catch (error) {
      console.error('Error clearing timeline:', error);
      this.showToast('Failed to clear timeline', 'error');
    }
  }

  getChangeIcon(changeType) {
    const icons = {
      'created': '➕',
      'modified': '✏️',
      'deleted': '🗑️'
    };
    return icons[changeType] || '📝';
  }

  getSourceIcon(sourceType) {
    const icons = {
      'git': '🔀',
      'editor': '📝',
      'ssh': '💻',
      'batch': '📦',
      'unknown': '❓'
    };
    return icons[sourceType] || '❓';
  }

  formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    // Less than 1 minute
    if (diff < 60000) {
      return 'Just now';
    }

    // Less than 1 hour
    if (diff < 3600000) {
      const minutes = Math.floor(diff / 60000);
      return `${minutes} minute${minutes !== 1 ? 's' : ''} ago`;
    }

    // Less than 24 hours
    if (diff < 86400000) {
      const hours = Math.floor(diff / 3600000);
      return `${hours} hour${hours !== 1 ? 's' : ''} ago`;
    }

    // Less than 7 days
    if (diff < 604800000) {
      const days = Math.floor(diff / 86400000);
      return `${days} day${days !== 1 ? 's' : ''} ago`;
    }

    // Default: format as date
    return date.toLocaleString();
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-show');
    }, 10);

    setTimeout(() => {
      toast.classList.remove('toast-show');
      setTimeout(() => {
        toast.remove();
      }, 300);
    }, 3000);
  }

  renderError(message) {
    const container = document.getElementById('timeline-container');
    container.innerHTML = `
      <div class="timeline-error">
        <div class="error-icon">⚠️</div>
        <div class="error-text">${message}</div>
      </div>
    `;
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
