// public/js/mini-indicator.js
class DiffExecutorIndicator {
  constructor() {
    this.ws = null;
    this.pendingCount = 0;
    this.init();
  }

  init() {
    this.createIndicator();
    this.connectWebSocket();
  }

  createIndicator() {
    const indicator = document.createElement('div');
    indicator.id = 'diff-executor-indicator';
    indicator.className = 'side-panel-widget';
    indicator.innerHTML = `
      <div class="widget-header" onclick="window.open('/diff-executor', 'diff-executor')">
        <span class="widget-icon">🔧</span>
        <span class="widget-title">Diff Executor</span>
        <span id="diff-pending-badge" class="badge">0</span>
      </div>
      <div class="widget-body">
        <div id="diff-status">No pending diffs</div>
      </div>
    `;
    
    // Add to side panel (adjust selector as needed)
    document.querySelector('.side-panel').appendChild(indicator);
  }

  connectWebSocket() {
    const ws = new WebSocket('ws://localhost:3045');
    
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'connected' || message.type.startsWith('job:')) {
        this.updateIndicator(message.data);
      }
    };
  }

  updateIndicator(data) {
    const badge = document.getElementById('diff-pending-badge');
    const status = document.getElementById('diff-status');
    
    if (data.jobCount !== undefined) {
      this.pendingCount = data.jobCount;
      badge.textContent = this.pendingCount;
      badge.style.display = this.pendingCount > 0 ? 'inline' : 'none';
      
      status.textContent = this.pendingCount > 0 
        ? `${this.pendingCount} pending diffs`
        : 'No pending diffs';
    }
  }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new DiffExecutorIndicator();
});