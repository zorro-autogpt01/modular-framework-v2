// Timeline UI JavaScript
// Frontend for file watcher timeline with hover diffs

class FileWatcherTimeline {
  constructor(connection_id, repo_name) {
    this.connection_id = connection_id;
    this.repo_name = repo_name;
    this.timeline = [];
    this.batches = new Map();
    this.diffCache = new Map();
    this.hoverTimeout = null;
    this.currentFilters = {
      search: '',
      source: '',
      startDate: '',
      endDate: '',
      limit: 100
    };
    
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.loadTimeline();
  }

  setupEventListeners() {
    // Search input with debounce
    const searchInput = document.getElementById('timeline-search');
    if (searchInput) {
      let searchTimeout;
      searchInput.addEventListener('input', (e) => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          this.currentFilters.search = e.target.value;
          this.loadTimeline();
        }, 300);
      });
    }

    // Source filter
    const sourceFilter = document.getElementById('timeline-source-filter');
    if (sourceFilter) {
      sourceFilter.addEventListener('change', (e) => {
        this.currentFilters.source = e.target.value;
        this.loadTimeline();
      });
    }

    // Date filters
    const startDate = document.getElementById('timeline-start-date');
    const endDate = document.getElementById('timeline-end-date');
    
    if (startDate) {
      startDate.addEventListener('change', (e) => {
        this.currentFilters.startDate = e.target.value;
        this.loadTimeline();
      });
    }
    
    if (endDate) {
      endDate.addEventListener('change', (e) => {
        this.currentFilters.endDate = e.target.value;
        this.loadTimeline();
      });
    }

    // Diff mode selector
    const diffModeSelector = document.getElementById('diff-mode-selector');
    if (diffModeSelector) {
      diffModeSelector.addEventListener('change', (e) => {
        this.currentDiffMode = e.target.value;
        // Reload current diff if one is showing
        if (this.currentDiffSnapshot) {
          this.showFullDiff(this.currentDiffSnapshot);
        }
      });
    }

    // Clear timeline button
    const clearBtn = document.getElementById('clear-timeline-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => this.clearTimeline());
    }
  }

  async loadTimeline() {
    try {
      const params = new URLSearchParams(this.currentFilters);
      const response = await fetch(
        `/api/file-watcher/timeline/${this.connection_id}/${this.repo_name}?${params}`
      );
      
      const data = await response.json();
      
      if (data.success) {
        this.timeline = data.timeline;
        this.renderTimeline();
      } else {
        console.error('Failed to load timeline:', data.error);
        this.showError('Failed to load timeline');
      }
    } catch (error) {
      console.error('Error loading timeline:', error);
      this.showError('Error loading timeline');
    }
  }

  renderTimeline() {
    const container = document.getElementById('timeline-container');
    if (!container) return;

    if (this.timeline.length === 0) {
      container.innerHTML = `
        <div class="timeline-empty">
          <div class="empty-icon">📁</div>
          <div class="empty-text">No file changes yet</div>
          <div class="empty-subtext">Make some changes to see them here</div>
        </div>
      `;
      return;
    }

    // Group by batch
    const grouped = this.groupByBatch(this.timeline);
    
    let html = '<div class="timeline-list">';
    
    for (const group of grouped) {
      if (group.type === 'batch') {
        html += this.renderBatch(group);
      } else {
        html += this.renderSnapshot(group.snapshot);
      }
    }
    
    html += '</div>';
    container.innerHTML = html;

    // Attach event listeners
    this.attachTimelineEvents();
  }

  groupByBatch(timeline) {
    const groups = [];
    const batchMap = new Map();

    for (const item of timeline) {
      if (item.batch_id) {
        if (!batchMap.has(item.batch_id)) {
          batchMap.set(item.batch_id, {
            type: 'batch',
            batch_id: item.batch_id,
            batch_created_at: item.batch_created_at,
            batch_source_type: item.batch_source_type,
            batch_source_operation: item.batch_source_operation,
            batch_file_count: item.batch_file_count,
            snapshots: []
          });
        }
        batchMap.get(item.batch_id).snapshots.push(item);
      } else {
        groups.push({
          type: 'single',
          snapshot: item
        });
      }
    }

    // Add batches to groups
    for (const batch of batchMap.values()) {
      groups.push(batch);
    }

    // Sort by date
    groups.sort((a, b) => {
      const dateA = a.type === 'batch' ? a.batch_created_at : a.snapshot.created_at;
      const dateB = b.type === 'batch' ? b.batch_created_at : b.snapshot.created_at;
      return new Date(dateB) - new Date(dateA);
    });

    return groups;
  }

  renderBatch(batch) {
    const icon = this.getSourceIcon(batch.batch_source_type);
    const collapsed = batch.snapshots.length > 1; // Collapse if more than 1 file

    return `
      <div class="timeline-batch" data-batch-id="${batch.batch_id}">
        <div class="timeline-item batch-header" onclick="timelineUI.toggleBatch(${batch.batch_id})">
          <div class="timeline-marker ${batch.batch_source_type}"></div>
          <div class="timeline-content">
            <div class="timeline-header">
              <span class="timeline-icon">${icon}</span>
              <span class="timeline-title">
                ${this.formatSourceOperation(batch.batch_source_operation)}
              </span>
              <span class="timeline-count">${batch.snapshots.length} files</span>
              <span class="timeline-time">${this.formatTime(batch.batch_created_at)}</span>
              <span class="batch-toggle ${collapsed ? 'collapsed' : ''}">
                ${collapsed ? '▶' : '▼'}
              </span>
            </div>
            <div class="timeline-meta">
              ${this.formatDate(batch.batch_created_at)}
            </div>
          </div>
        </div>
        <div class="batch-files ${collapsed ? 'collapsed' : ''}">
          ${batch.snapshots.map(s => this.renderSnapshot(s, true)).join('')}
        </div>
      </div>
    `;
  }

  renderSnapshot(snapshot, isInBatch = false) {
    const icon = this.getChangeTypeIcon(snapshot.change_type);
    const sourceIcon = isInBatch ? '' : this.getSourceIcon(snapshot.source_type);
    const stats = snapshot.diff ? snapshot.diff.stats : null;

    return `
      <div class="timeline-item ${isInBatch ? 'in-batch' : ''}" 
           data-snapshot-id="${snapshot.id}"
           onmouseenter="timelineUI.showDiffPreview(${snapshot.id}, event)"
           onmouseleave="timelineUI.hideDiffPreview()">
        ${!isInBatch ? `<div class="timeline-marker ${snapshot.source_type}"></div>` : ''}
        <div class="timeline-content">
          <div class="timeline-header">
            ${!isInBatch ? `<span class="timeline-icon">${sourceIcon}</span>` : ''}
            <span class="change-type-icon">${icon}</span>
            <span class="timeline-title">${snapshot.file_path}</span>
            ${!isInBatch ? `<span class="timeline-time">${this.formatTime(snapshot.created_at)}</span>` : ''}
          </div>
          ${stats ? `
            <div class="timeline-stats">
              ${stats.additions > 0 ? `<span class="stat-add">+${stats.additions}</span>` : ''}
              ${stats.deletions > 0 ? `<span class="stat-del">-${stats.deletions}</span>` : ''}
              ${stats.modifications > 0 ? `<span class="stat-mod">~${stats.modifications}</span>` : ''}
            </div>
          ` : ''}
          ${!isInBatch ? `<div class="timeline-meta">${this.formatDate(snapshot.created_at)}</div>` : ''}
          <div class="timeline-actions">
            <button onclick="timelineUI.showFullDiff(${snapshot.id})" class="btn-small">
              View Diff
            </button>
            <button onclick="timelineUI.viewFileHistory('${snapshot.file_path}')" class="btn-small">
              History
            </button>
            <button onclick="timelineUI.restoreFile(${snapshot.id})" class="btn-small btn-restore">
              Restore
            </button>
          </div>
        </div>
      </div>
    `;
  }

  attachTimelineEvents() {
    // Events are handled via inline onclick for simplicity
    // Could be refactored to use event delegation
  }

  toggleBatch(batchId) {
    const batch = document.querySelector(`[data-batch-id="${batchId}"]`);
    if (!batch) return;

    const files = batch.querySelector('.batch-files');
    const toggle = batch.querySelector('.batch-toggle');
    
    files.classList.toggle('collapsed');
    toggle.classList.toggle('collapsed');
    toggle.textContent = files.classList.contains('collapsed') ? '▶' : '▼';
  }

  async showDiffPreview(snapshotId, event) {
    // Clear existing timeout
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
    }

    // Wait before showing preview
    this.hoverTimeout = setTimeout(async () => {
      const snapshot = this.timeline.find(s => s.id === snapshotId);
      if (!snapshot || !snapshot.diff) return;

      const preview = snapshot.diff.preview;
      if (!preview || preview.length === 0) return;

      // Create preview tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'diff-preview-tooltip';
      tooltip.innerHTML = this.renderDiffPreview(preview);

      // Position tooltip
      const rect = event.target.closest('.timeline-item').getBoundingClientRect();
      tooltip.style.position = 'fixed';
      tooltip.style.left = `${rect.right + 10}px`;
      tooltip.style.top = `${rect.top}px`;
      tooltip.style.maxHeight = '400px';
      tooltip.style.overflow = 'auto';

      document.body.appendChild(tooltip);
      this.currentTooltip = tooltip;
    }, 300);
  }

  hideDiffPreview() {
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
    }

    if (this.currentTooltip) {
      this.currentTooltip.remove();
      this.currentTooltip = null;
    }
  }

  renderDiffPreview(preview) {
    return `
      <div class="diff-preview">
        ${preview.map(line => `
          <div class="diff-line diff-${line.type}">
            <span class="line-num">${line.lineNum || ''}</span>
            <span class="line-content">${this.escapeHtml(line.content)}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  async showFullDiff(snapshotId) {
    const mode = this.currentDiffMode || 'unified';
    
    try {
      const snapshot = this.timeline.find(s => s.id === snapshotId);
      if (!snapshot) return;

      const response = await fetch(
        `/api/file-watcher/diff/${this.connection_id}/${this.repo_name}?` +
        `file_path=${encodeURIComponent(snapshot.file_path)}&` +
        `to_snapshot=${snapshotId}&mode=${mode}`
      );

      const data = await response.json();
      
      if (data.success) {
        this.currentDiffSnapshot = snapshotId;
        this.renderFullDiff(data.diff, data.mode, snapshot.file_path);
      }
    } catch (error) {
      console.error('Error loading diff:', error);
      this.showError('Failed to load diff');
    }
  }

  renderFullDiff(diff, mode, filePath) {
    const modal = document.getElementById('diff-modal');
    if (!modal) return;

    const title = document.getElementById('diff-modal-title');
    const content = document.getElementById('diff-modal-content');

    title.textContent = `Diff: ${filePath}`;

    if (mode === 'split') {
      content.innerHTML = this.renderSplitDiff(diff);
    } else if (mode === 'inline') {
      content.innerHTML = this.renderInlineDiff(diff);
    } else {
      content.innerHTML = this.renderUnifiedDiff(diff);
    }

    modal.style.display = 'block';
  }

  renderUnifiedDiff(diff) {
    const formatted = diff.changes || [];
    let html = '<div class="diff-unified">';
    
    let lineNum = 1;
    for (const change of formatted) {
      const lines = change.value.split('\n').filter(l => l);
      for (const line of lines) {
        const type = change.added ? 'added' : (change.removed ? 'removed' : 'context');
        html += `
          <div class="diff-line diff-${type}">
            <span class="line-num">${lineNum++}</span>
            <span class="line-content">${this.escapeHtml(line)}</span>
          </div>
        `;
      }
    }
    
    html += '</div>';
    return html;
  }

  renderSplitDiff(diff) {
    const { left, right } = diff;
    let html = '<div class="diff-split"><div class="diff-pane">';
    
    // Left pane (old)
    html += '<div class="diff-pane-title">Before</div>';
    for (const line of left) {
      html += `
        <div class="diff-line diff-${line.type}">
          <span class="line-num">${line.lineNum || ''}</span>
          <span class="line-content">${this.escapeHtml(line.content)}</span>
        </div>
      `;
    }
    
    html += '</div><div class="diff-pane">';
    
    // Right pane (new)
    html += '<div class="diff-pane-title">After</div>';
    for (const line of right) {
      html += `
        <div class="diff-line diff-${line.type}">
          <span class="line-num">${line.lineNum || ''}</span>
          <span class="line-content">${this.escapeHtml(line.content)}</span>
        </div>
      `;
    }
    
    html += '</div></div>';
    return html;
  }

  renderInlineDiff(diff) {
    let html = '<div class="diff-inline">';
    
    for (const line of diff) {
      html += `
        <div class="diff-line diff-${line.type}">
          <span class="line-num">${line.lineNum}</span>
          <span class="line-content">${this.escapeHtml(line.content)}</span>
        </div>
      `;
    }
    
    html += '</div>';
    return html;
  }

  async viewFileHistory(filePath) {
    try {
      const response = await fetch(
        `/api/file-watcher/file-history/${this.connection_id}/${this.repo_name}/${encodeURIComponent(filePath)}`
      );

      const data = await response.json();
      
      if (data.success) {
        this.showFileHistory(data.history, filePath);
      }
    } catch (error) {
      console.error('Error loading file history:', error);
      this.showError('Failed to load file history');
    }
  }

  showFileHistory(history, filePath) {
    const modal = document.getElementById('history-modal');
    if (!modal) return;

    const title = document.getElementById('history-modal-title');
    const content = document.getElementById('history-modal-content');

    title.textContent = `History: ${filePath}`;

    let html = '<div class="file-history-list">';
    for (const snapshot of history) {
      html += this.renderSnapshot(snapshot, false);
    }
    html += '</div>';

    content.innerHTML = html;
    modal.style.display = 'block';
  }

  async restoreFile(snapshotId) {
    if (!confirm('Are you sure you want to restore this file? Current version will be overwritten.')) {
      return;
    }

    try {
      const response = await fetch(
        `/api/file-watcher/restore/${this.connection_id}/${this.repo_name}/${snapshotId}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true })
        }
      );

      const data = await response.json();
      
      if (data.success) {
        this.showSuccess(`File restored: ${data.file_path}`);
        this.loadTimeline(); // Reload timeline
      } else {
        this.showError(data.error);
      }
    } catch (error) {
      console.error('Error restoring file:', error);
      this.showError('Failed to restore file');
    }
  }

  async clearTimeline() {
    if (!confirm('Are you sure you want to clear all timeline history? This cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(
        `/api/file-watcher/timeline/${this.connection_id}/${this.repo_name}`,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true })
        }
      );

      const data = await response.json();
      
      if (data.success) {
        this.showSuccess('Timeline cleared');
        this.timeline = [];
        this.renderTimeline();
      } else {
        this.showError(data.error);
      }
    } catch (error) {
      console.error('Error clearing timeline:', error);
      this.showError('Failed to clear timeline');
    }
  }

  // Utility functions

  getSourceIcon(sourceType) {
    const icons = {
      'git': '🔀',
      'editor': '✏️',
      'ssh': '💻',
      'batch': '📦',
      'package_manager': '📦',
      'build': '🔨',
      'testing': '🧪',
      'unknown': '❓'
    };
    return icons[sourceType] || icons.unknown;
  }

  getChangeTypeIcon(changeType) {
    const icons = {
      'modified': '📝',
      'created': '➕',
      'deleted': '🗑️'
    };
    return icons[changeType] || '📝';
  }

  formatSourceOperation(operation) {
    const labels = {
      'commit': 'Git Commit',
      'pull': 'Git Pull',
      'merge': 'Git Merge',
      'checkout': 'Git Checkout',
      'stash': 'Git Stash',
      'file_change': 'File Changed',
      'multiple_files': 'Batch Update',
      'dependency_update': 'Dependencies Updated',
      'compilation': 'Build Output',
      'test_execution': 'Tests Run'
    };
    return labels[operation] || operation;
  }

  formatTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  }

  formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    
    return date.toLocaleDateString();
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showError(message) {
    // Implement your error notification
    alert('Error: ' + message);
  }

  showSuccess(message) {
    // Implement your success notification
    console.log('Success:', message);
  }
}

// Make globally available
window.FileWatcherTimeline = FileWatcherTimeline;