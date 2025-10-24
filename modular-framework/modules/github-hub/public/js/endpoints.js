// public/js/endpoints.js
// Endpoint browser functionality

// Helper functions (needed if app.js is a module)
//const $ = (id) => document.getElementById(id);

// Access global functions from app.js
//const getGlobal = (name) => window[name];
//const api = (...args) => window.api ? window.api(...args) : Promise.reject('API not ready');
//const toast = (...args) => window.toast ? window.toast(...args) : console.log(...args);
//const parseRepoFromUrl = (...args) => window.parseRepoFromUrl ? window.parseRepoFromUrl(...args) : null;

let endpointMappings = null;
let selectedEndpoint = null;
let selectedFiles = new Set();

// Initialize endpoint view
function initEndpointView() {
  const endpointViewBtn = $('endpointViewBtn');
  const treeViewBtn = $('treeViewBtn');
  
  if (endpointViewBtn) {
    endpointViewBtn.addEventListener('click', () => switchToEndpointView());
  }
  
  if (treeViewBtn) {
    treeViewBtn.addEventListener('click', () => switchToTreeView());
  }
  
  // Search functionality
  const searchInput = $('endpointSearch');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => filterEndpoints(e.target.value));
  }
  
  // Export buttons
  const exportBtn = $('exportEndpointBtn');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportSelectedFiles());
  }
  
  const copyAllBtn = $('copyAllEndpointBtn');
  if (copyAllBtn) {
    copyAllBtn.addEventListener('click', () => copyAllFiles());
  }
  
  console.log('✅ Endpoint view initialized');
}

// Switch between views
function switchToEndpointView() {
  $('treeView').style.display = 'none';
  $('endpointView').style.display = 'flex';
  $('treeViewBtn').classList.remove('active');
  $('endpointViewBtn').classList.add('active');
  
  // Load endpoints if not already loaded
  if (!endpointMappings) {
    loadEndpointMappings();
  }
}

function switchToTreeView() {
  $('treeView').style.display = 'block';
  $('endpointView').style.display = 'none';
  $('treeViewBtn').classList.add('active');
  $('endpointViewBtn').classList.remove('active');
}

// Load endpoint mappings from backend
async function loadEndpointMappings(force = false) {
  const repoUrl = $('repoUrl')?.value;
  if (!repoUrl) {
    toast('No repository loaded', false);
    return;
  }
  
  const { owner, repo } = parseRepoFromUrl(repoUrl);
  if (!owner || !repo) {
    toast('Invalid repository URL', false);
    return;
  }
  
  const container = $('endpointListContainer');
  const loadingDiv = $('endpointLoading');
  
  if (loadingDiv) loadingDiv.style.display = 'flex';
  if (container) container.style.display = 'none';
  
  try {
    console.log(`🔄 Loading endpoint mappings for ${owner}/${repo}...`);
    
    const data = await api(`/map-openapi/${owner}/${repo}?force=${force}`, {
      method: 'POST'
    }, { noConn: true });
    
    if (data.error) {
      showEndpointError(data);
      return;
    }
    
    endpointMappings = data;
    console.log(`✅ Loaded ${data.total_endpoints} endpoints`);
    
    renderEndpointList(data);
    renderSummaryStats(data);
    
    toast(`Loaded ${data.total_endpoints} endpoints`, true);
    
  } catch (err) {
    console.error('❌ Failed to load endpoints:', err);
    showEndpointError({ 
      error: err.message,
      hint: 'Make sure your repository has an OpenAPI specification file'
    });
  } finally {
    if (loadingDiv) loadingDiv.style.display = 'none';
  }
}

// Show error message
function showEndpointError(data) {
  const container = $('endpointListContainer');
  if (!container) return;
  
  container.style.display = 'block';
  container.innerHTML = `
    <div class="endpoint-error">
      <div class="error-icon">⚠️</div>
      <div class="error-title">${data.error || 'Failed to load endpoints'}</div>
      <div class="error-hint">${data.hint || ''}</div>
      ${data.searched_files ? `
        <details style="margin-top: 12px;">
          <summary>Files searched</summary>
          <pre style="font-size: 11px; margin-top: 8px;">${data.searched_files.join('\n')}</pre>
        </details>
      ` : ''}
      <button onclick="loadEndpointMappings(true)" style="margin-top: 16px;">Retry</button>
    </div>
  `;
}

// Render endpoint list
function renderEndpointList(data) {
  const container = $('endpointListContainer');
  if (!container) return;
  
  container.style.display = 'block';
  container.innerHTML = '';
  
  // Group by tags
  const groupedByTag = {};
  
  data.mappings.forEach(mapping => {
    const tags = mapping.tags || ['Other'];
    tags.forEach(tag => {
      if (!groupedByTag[tag]) {
        groupedByTag[tag] = [];
      }
      groupedByTag[tag].push(mapping);
    });
  });
  
  // Render each tag group
  Object.entries(groupedByTag).forEach(([tag, endpoints]) => {
    const group = document.createElement('div');
    group.className = 'endpoint-group';
    group.dataset.tag = tag;
    
    const header = document.createElement('div');
    header.className = 'endpoint-group-header';
    header.innerHTML = `
      <span class="group-name">${tag}</span>
      <span class="group-count">${endpoints.length}</span>
    `;
    
    header.addEventListener('click', () => {
      group.classList.toggle('collapsed');
    });
    
    group.appendChild(header);
    
    const list = document.createElement('div');
    list.className = 'endpoint-list';
    
    endpoints.forEach(endpoint => {
      const item = document.createElement('div');
      item.className = 'endpoint-item';
      if (endpoint.error) {
        item.classList.add('no-handler');
      }
      
      item.innerHTML = `
        <span class="method method-${endpoint.method.toLowerCase()}">${endpoint.method}</span>
        <span class="path" title="${endpoint.summary}">${endpoint.path}</span>
        ${endpoint.error ? 
          '<span class="no-handler-badge">No handler</span>' :
          `<span class="file-count">${endpoint.stats?.total_files || 0} files</span>`
        }
      `;
      
      if (!endpoint.error) {
        item.addEventListener('click', () => showEndpointCode(endpoint));
      }
      
      list.appendChild(item);
    });
    
    group.appendChild(list);
    container.appendChild(group);
  });
}

// Render summary stats
function renderSummaryStats(data) {
  const statsDiv = $('endpointStats');
  if (!statsDiv) return;
  
  statsDiv.innerHTML = `
    <div class="stat-item">
      <div class="stat-value">${data.total_endpoints}</div>
      <div class="stat-label">Endpoints</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.endpoints_with_handlers}</div>
      <div class="stat-label">With Handlers</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${data.stats?.total_files_referenced || 0}</div>
      <div class="stat-label">Files</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${(data.stats?.total_tokens || 0).toLocaleString()}</div>
      <div class="stat-label">Tokens</div>
    </div>
  `;
}

// Show code for selected endpoint
function showEndpointCode(endpoint) {
  selectedEndpoint = endpoint;
  selectedFiles.clear();
  
  const codeView = $('endpointCodeView');
  if (!codeView) return;
  
  codeView.innerHTML = '';
  codeView.scrollTop = 0;
  
  // Header
  const header = document.createElement('div');
  header.className = 'endpoint-code-header';
  header.innerHTML = `
    <div class="endpoint-title">
      <span class="method method-${endpoint.method.toLowerCase()}">${endpoint.method}</span>
      <span class="path">${endpoint.path}</span>
    </div>
    <div class="endpoint-summary">${endpoint.summary || endpoint.description || ''}</div>
    <div class="endpoint-stats">
      <span><strong>${endpoint.stats?.total_files || 0}</strong> files</span>
      <span><strong>${(endpoint.stats?.total_tokens || 0).toLocaleString()}</strong> tokens</span>
      <span><strong>${(endpoint.stats?.total_lines || 0).toLocaleString()}</strong> lines</span>
    </div>
    <div class="endpoint-actions">
      <button class="btn-select-all" onclick="selectAllFiles()">Select All</button>
      <button class="btn-copy-all" onclick="copySelectedFiles()">Copy Selected</button>
      <button class="btn-export" onclick="exportToLLM()">Export for LLM</button>
    </div>
  `;
  
  codeView.appendChild(header);
  
  // Files
  endpoint.files.forEach((file, index) => {
    const fileCard = createFileCard(file, index);
    codeView.appendChild(fileCard);
  });
  
  // Highlight selected endpoint in list
  document.querySelectorAll('.endpoint-item').forEach(item => {
    item.classList.remove('selected');
  });
  
  const selectedItem = Array.from(document.querySelectorAll('.endpoint-item')).find(item => {
    return item.textContent.includes(endpoint.method) && item.textContent.includes(endpoint.path);
  });
  
  if (selectedItem) {
    selectedItem.classList.add('selected');
  }
}

// Create file card
function createFileCard(file, index) {
  const card = document.createElement('div');
  card.className = 'file-card';
  card.dataset.path = file.path;
  
  const roleClass = `role-${file.role}`;
  const roleIcon = getRoleIcon(file.role);
  
  card.innerHTML = `
    <div class="file-card-header">
      <input type="checkbox" class="file-select" data-index="${index}" 
             onchange="toggleFileSelection(this, ${index})">
      <span class="file-role ${roleClass}">${roleIcon} ${file.role}</span>
      <span class="file-path" title="${file.path}">${file.path}</span>
      <span class="file-tokens">${file.tokens.toLocaleString()} tok</span>
      <button class="btn-toggle" onclick="toggleFileContent(${index})">
        <span class="show-text">Show Full</span>
        <span class="hide-text" style="display:none">Show Snippet</span>
      </button>
    </div>
    <div class="file-card-body">
      <pre class="code-snippet active" data-index="${index}">${escapeHtml(file.snippet)}</pre>
      <pre class="code-full" data-index="${index}" style="display:none">${escapeHtml(file.full_content)}</pre>
    </div>
  `;
  
  return card;
}

// Get role icon
function getRoleIcon(role) {
  const icons = {
    'handler': '🎯',
    'service': '⚙️',
    'model': '📦',
    'database': '🗄️',
    'utility': '🔧',
    'auth': '🔐',
    'middleware': '🔀',
    'config': '⚙️',
    'dependency': '📄'
  };
  return icons[role] || '📄';
}

// Toggle file content
function toggleFileContent(index) {
  const snippet = document.querySelector(`.code-snippet[data-index="${index}"]`);
  const full = document.querySelector(`.code-full[data-index="${index}"]`);
  const btn = snippet.closest('.file-card').querySelector('.btn-toggle');
  
  if (snippet.style.display !== 'none') {
    snippet.style.display = 'none';
    full.style.display = 'block';
    btn.querySelector('.show-text').style.display = 'none';
    btn.querySelector('.hide-text').style.display = 'inline';
  } else {
    snippet.style.display = 'block';
    full.style.display = 'none';
    btn.querySelector('.show-text').style.display = 'inline';
    btn.querySelector('.hide-text').style.display = 'none';
  }
}

// Toggle file selection
function toggleFileSelection(checkbox, index) {
  if (checkbox.checked) {
    selectedFiles.add(index);
  } else {
    selectedFiles.delete(index);
  }
  
  updateSelectionCount();
}

// Select all files
function selectAllFiles() {
  document.querySelectorAll('.file-select').forEach(checkbox => {
    checkbox.checked = true;
    const index = parseInt(checkbox.dataset.index);
    selectedFiles.add(index);
  });
  
  updateSelectionCount();
}

// Update selection count
function updateSelectionCount() {
  const count = selectedFiles.size;
  const countDisplay = $('selectedFileCount');
  
  if (countDisplay) {
    countDisplay.textContent = `${count} file${count !== 1 ? 's' : ''} selected`;
  }
}

// Copy selected files
async function copySelectedFiles() {
  if (selectedFiles.size === 0) {
    toast('No files selected', false);
    return;
  }
  
  const files = Array.from(selectedFiles).map(index => {
    return selectedEndpoint.files[index];
  });
  
  const parts = [];
  files.forEach(file => {
    parts.push(`# ${file.path}`);
    parts.push(file.full_content);
    parts.push('\n');
  });
  
  const text = parts.join('\n');
  
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${files.length} files to clipboard`, true);
  } catch (err) {
    console.error('Copy failed:', err);
    toast('Copy failed', false);
  }
}

// Copy all files
async function copyAllFiles() {
  if (!selectedEndpoint || !selectedEndpoint.files) {
    toast('No endpoint selected', false);
    return;
  }
  
  const parts = [];
  selectedEndpoint.files.forEach(file => {
    parts.push(`# ${file.path}`);
    parts.push(file.full_content);
    parts.push('\n');
  });
  
  const text = parts.join('\n');
  
  try {
    await navigator.clipboard.writeText(text);
    const tokenCount = selectedEndpoint.stats?.total_tokens || 0;
    toast(`Copied all files (${tokenCount.toLocaleString()} tokens)`, true);
  } catch (err) {
    console.error('Copy failed:', err);
    toast('Copy failed', false);
  }
}

// Export to LLM format
async function exportToLLM() {
  if (selectedFiles.size === 0) {
    toast('No files selected', false);
    return;
  }
  
  const files = Array.from(selectedFiles).map(index => {
    const file = selectedEndpoint.files[index];
    return {
      path: file.path,
      content: file.full_content
    };
  });
  
  try {
    const response = await api('/export-endpoint-context', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: files,
        format: 'xml'  // or 'concatenated'
      })
    }, { noConn: true });
    
    await navigator.clipboard.writeText(response.content);
    toast(`Exported ${files.length} files (${response.token_estimate.toLocaleString()} tokens)`, true);
    
  } catch (err) {
    console.error('Export failed:', err);
    toast('Export failed', false);
  }
}

// Filter endpoints
function filterEndpoints(searchText) {
  const search = searchText.toLowerCase();
  
  document.querySelectorAll('.endpoint-item').forEach(item => {
    const text = item.textContent.toLowerCase();
    
    if (text.includes(search)) {
      item.style.display = 'flex';
    } else {
      item.style.display = 'none';
    }
  });
  
  // Hide empty groups
  document.querySelectorAll('.endpoint-group').forEach(group => {
    const visibleItems = group.querySelectorAll('.endpoint-item[style*="flex"]').length;
    group.style.display = visibleItems > 0 ? 'block' : 'none';
  });
}

// Escape HTML
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Auto-initialize when DOM is ready
setTimeout(() => {
  initEndpointView();
}, 150);

console.log('📦 Endpoint module loaded');
