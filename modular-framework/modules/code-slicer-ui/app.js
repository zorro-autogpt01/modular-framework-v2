// Code Slicer UI - Main Application
// Connects to Code Slicer Service and LLM Gateway

// Configuration - Update these URLs as needed
const CONFIG = {
    CODE_SLICER_URL: '/api/slice',  // Will be proxied by the server
    LLM_GATEWAY_URL: '/api/llm',     // Will be proxied by the server
    AI_ASSISTANT_URL: '/api/assist', // If using orchestrator service
    GITHUB_HUB_URL: '/api/repos',    // GitHub Hub proxy
    MODELS_URL: '/api/models'        // LLM models endpoint
};

// State
const state = {
    targets: [],
    hints: [],
    currentAnalysis: null,
    chatHistory: [],
    sessionId: Date.now().toString(),
    repositories: [],
    models: [],
    selectedRepo: null,
    selectedBranch: null,
    selectedModel: 'claude-sonnet-4',
    isSending: false
};

// Utility Functions
function showAlert(message, type = 'info') {
    const alertClass = `alert-${type}`;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    
    const alert = document.createElement('div');
    alert.className = `alert ${alertClass}`;
    alert.innerHTML = `<span>${icon}</span><span>${message}</span>`;
    
    const container = document.querySelector('.container');
    container.insertBefore(alert, container.firstChild);
    
    setTimeout(() => alert.remove(), 5000);
}

function formatNumber(num) {
    return new Intl.NumberFormat().format(num);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Check service health
async function checkHealth() {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    
    try {
        const response = await fetch(`${CONFIG.CODE_SLICER_URL}/../../health`);
        
        if (response.ok) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected';
        } else {
            statusText.textContent = 'Service Error';
        }
    } catch (error) {
        statusText.textContent = 'Disconnected';
        console.error('Health check failed:', error);
    }
}

// Load repositories from GitHub Hub
async function loadRepositories() {
  try {
    const response = await fetch(CONFIG.GITHUB_HUB_URL);
    if (!response.ok) throw new Error('Failed to fetch repositories');

    const data = await response.json();

    state.defaultConnId = data.default_connection_id || null;
    state.repositories = (data.repositories || []).map(r => ({
      owner: r.owner,
      name: r.name,
      full_name: r.full_name,
      connection_id: r.connection_id,
      default_branch: r.default_branch || 'main'
    }));

    // Update all repo dropdowns
    updateRepoDropdowns();

  } catch (error) {
    console.error('Failed to load repositories:', error);
    showAlert('Failed to load repositories from GitHub Hub', 'error');
  }
}

// Update repository dropdowns (value is full_name for display; dataset keeps conn_id)
function updateRepoDropdowns() {
  const repoSelects = ['repo', 'chat-repo', 'issue-repo', 'pr-repo', 'compare-repo', 'branches-repo'];

  repoSelects.forEach(selectId => {
    const select = document.getElementById(selectId);
    if (!select) return;

    select.innerHTML = '<option value="">Select repository...</option>';

    state.repositories.forEach(repo => {
      if (!repo.full_name) return;
      const option = document.createElement('option');
      option.value = repo.full_name;                       // used in Code Slicer requests
      option.textContent = repo.full_name;                 // what the user sees
      option.dataset.connId = repo.connection_id;          // used to call GH Hub
      option.dataset.defaultBranch = repo.default_branch;  // fallback
      select.appendChild(option);
    });
  });
}

// Load branches for a repository (requires conn_id)
async function loadBranches(selectValue, targetSelectId, connId) {
  const select = document.getElementById(targetSelectId);
  if (!select) return;

  select.innerHTML = '<option value="">Loading branches...</option>';

  try {
    if (!connId) throw new Error('Missing connection id for branch listing');

    const response = await fetch(`${CONFIG.GITHUB_HUB_URL}/${encodeURIComponent(connId)}/branches`);
    if (!response.ok) throw new Error('Failed to fetch branches');

    const data = await response.json();
    const branches = data.branches || [];

    select.innerHTML = '<option value="">Select branch...</option>';
    branches.forEach(branch => {
      const option = document.createElement('option');
      option.value = branch;
      option.textContent = branch;
      select.appendChild(option);
    });

    // Auto-select main/master if available (or default from repo)
    if (branches.includes('main')) {
      select.value = 'main';
    } else if (branches.includes('master')) {
      select.value = 'master';
    } else if (select.dataset.defaultBranch && branches.includes(select.dataset.defaultBranch)) {
      select.value = select.dataset.defaultBranch;
    }

  } catch (error) {
    console.error('Failed to load branches:', error);
    select.innerHTML = '<option value="">Failed to load branches</option>';
  }
}

// Load available LLM models
async function loadModels() {
    try {
        const response = await fetch(CONFIG.MODELS_URL);
        if (!response.ok) throw new Error('Failed to fetch models');
        
        const data = await response.json();
        state.models = data.models || [];
        
        updateModelDropdowns();
        
    } catch (error) {
        console.error('Failed to load models:', error);
        // Use defaults
        state.models = [
            { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
            { id: 'claude-opus-4', name: 'Claude Opus 4' },
            { id: 'gpt-4', name: 'GPT-4' }
        ];
        updateModelDropdowns();
    }
}

// Update model dropdowns
function updateModelDropdowns() {
    const modelSelects = ['chat-model'];
    
    modelSelects.forEach(selectId => {
        const select = document.getElementById(selectId);
        if (!select) return;
        
        select.innerHTML = '';
        
        state.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            if (model.id === state.selectedModel) {
                option.selected = true;
            }
            select.appendChild(option);
        });
    });
}

// Check service health
async function checkHealth() {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    
    try {
        const response = await fetch(`${CONFIG.CODE_SLICER_URL}/../../health`);
        
        if (response.ok) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected';
        } else {
            statusText.textContent = 'Service Error';
        }
    } catch (error) {
        statusText.textContent = 'Disconnected';
        console.error('Health check failed:', error);
    }
}

// Tab Management
function initTabs() {
    const tabs = document.querySelectorAll('.tab');
    const tabContents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            
            tabs.forEach(t => t.classList.remove('active'));
            tabContents.forEach(tc => tc.classList.remove('active'));
            
            tab.classList.add('active');
            document.getElementById(`${tabName}-tab`).classList.add('active');
        });
    });
}

// Tag Input Management
function initTagInput(containerId, inputId, array) {
    const container = document.getElementById(containerId);
    const input = document.getElementById(inputId);
    
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && input.value.trim()) {
            e.preventDefault();
            const value = input.value.trim();
            
            if (!array.includes(value)) {
                array.push(value);
                addTag(container, value, array);
                input.value = '';
            }
        }
    });
}

function addTag(container, value, array) {
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.innerHTML = `
        <span>${escapeHtml(value)}</span>
        <span class="tag-remove">×</span>
    `;
    
    tag.querySelector('.tag-remove').addEventListener('click', () => {
        const index = array.indexOf(value);
        if (index > -1) array.splice(index, 1);
        tag.remove();
    });
    
    container.insertBefore(tag, container.querySelector('.tag-input'));
}

// Manual Analysis
async function analyzeCode() {
    const repoSelect = document.getElementById('repo');
    const branchSelect = document.getElementById('branch');
    const repo = repoSelect.value;
    const branch = branchSelect.value || 'main';
    const context = parseInt(document.getElementById('context').value) || 15;
    const connId = document.getElementById('conn-id').value.trim() || null;
    
    if (!repo) {
        showAlert('Please select a repository', 'error');
        return;
    }
    
    if (!branch) {
        showAlert('Please select a branch', 'error');
        return;
    }
    
    if (state.targets.length === 0) {
        showAlert('Please add at least one target', 'error');
        return;
    }
    
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true;
    btn.innerHTML = '<div class="loading"><div class="spinner"></div><span>Analyzing...</span></div>';
    
    try {
        const response = await fetch(`${CONFIG.CODE_SLICER_URL}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo,
                branch,
                targets: state.targets,
                context,
                hints: state.hints,
                conn_id: connId,
                promptPack: true
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Analysis failed');
        }
        
        const data = await response.json();
        state.currentAnalysis = data;
        displayResults(data);
        showAlert('Analysis complete!', 'success');
        
    } catch (error) {
        showAlert(`Error: ${error.message}`, 'error');
        console.error('Analysis error:', error);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔍</span> Analyze Code';
    }
}

function displayResults(data) {
    const resultsSection = document.getElementById('results');
    const statsContainer = document.getElementById('result-stats');
    const codeContent = document.getElementById('code-content');
    
    resultsSection.style.display = 'block';
    
    // Display stats
    const stats = [
        { label: 'Files Analyzed', value: data.files?.length || 0 },
        { label: 'Code Snippets', value: data.snippets?.length || 0 },
        { label: 'Branch', value: data.branch || 'default' },
        { label: 'Context Lines', value: data.metadata?.context || 15 }
    ];
    
    statsContainer.innerHTML = stats.map(stat => `
        <div class="stat">
            <div class="stat-label">${stat.label}</div>
            <div class="stat-value">${stat.value}</div>
        </div>
    `).join('');
    
    // Display code
    codeContent.textContent = data.markdown || 'No code returned';
    
    // Scroll to results
    resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function clearForm() {
    state.targets = [];
    state.hints = [];
    
    document.querySelectorAll('.tag').forEach(tag => tag.remove());
    document.getElementById('target-input').value = '';
    document.getElementById('hint-input').value = '';
    document.getElementById('results').style.display = 'none';
}

function copyMarkdown() {
    if (!state.currentAnalysis?.markdown) {
        showAlert('No code to copy', 'error');
        return;
    }
    
    navigator.clipboard.writeText(state.currentAnalysis.markdown)
        .then(() => showAlert('Copied to clipboard!', 'success'))
        .catch(() => showAlert('Failed to copy', 'error'));
}

// AI Chat
// Replace sendChatMessage with this guarded version
async function sendChatMessage(e) {
  e.preventDefault();

  if (state.isSending) return;          // prevent double-submits
  state.isSending = true;

  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message) { state.isSending = false; return; }

  const repoSelect = document.getElementById('chat-repo');
  const branchSelect = document.getElementById('chat-branch');
  const repo = repoSelect.value;
  const branch = branchSelect.value || 'main';

  if (!repo) { showAlert('Please select a repository', 'error'); state.isSending = false; return; }
  if (!branch) { showAlert('Please select a branch', 'error'); state.isSending = false; return; }

  // Add user message to chat UI (not to history yet)
  addChatMessage('user', message);
  input.value = '';
  input.style.height = 'auto';

  // Show loading
const loadingId = addChatMessage('assistant', '<div class="loading"><div class="spinner"></div><span>Thinking...</span></div>', false, true);

  try {
    const response = await callAIAssistant(message, repo, branch);

    // Remove loading message
    document.getElementById(loadingId)?.remove();

    // Add AI response
    addChatMessage('assistant', response || '(no content)');

  } catch (error) {
    document.getElementById(loadingId)?.remove();
    addChatMessage('assistant', `Error: ${error.message}`, true);
    console.error('Chat error:', error);
  } finally {
    state.isSending = false;
  }
}


// Replace callAIAssistant with this (fallback on ANY non-OK)
async function callAIAssistant(message, repo, branch) {
  try {
    const response = await fetch(`${CONFIG.AI_ASSISTANT_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request: message,
        repo,
        branch,
        conversation_history: state.chatHistory
      })
    });

    if (response.ok) {
      const data = await response.json();
      state.chatHistory.push(
        { role: 'user', content: message },
        { role: 'assistant', content: data.response }
      );
      return data.response;
    }
  } catch (_) {
    // ignore network errors and fall back
  }

  // Fallback: direct Gateway
  return await callLLMDirectly(message, repo, branch);
}


// Replace callLLMDirectly with this version
async function callLLMDirectly(message, repo, branch) {
  const systemPrompt = `You are a code assistant embedded in a UI that integrates:
- Code Slicer service (POST /api/slice/analyze)
- GitHub Hub (connections, branches, files, batch commit, PR)
- LLM Gateway (chat)

Rules:
• If the user asks about CAPABILITIES ("can this app receive diffs, apply, test, push?"), answer directly with what's possible and outline concrete steps and endpoints (e.g., /api/file PUT, /api/batch/commit, /api/pr).
• Only ask for code when analysis of code is actually required.
• Be concise and actionable.

Context:
- Active repo: ${repo}
- Branch: ${branch}
- Code Slicer expects: repo, branch, targets[], context (POST /api/slice/analyze).`;

  const url = `${CONFIG.LLM_GATEWAY_URL}/v1/chat`;

  // Resolve the selected model to a full object from state.models
  const selectedVal = state.selectedModel; // this is option.value (server sent 'id' = key || model_name)
  const modelRow = state.models.find(m => (m.key || m.model_name) === selectedVal || m.id === selectedVal);

  const body = {
    // Give the gateway the best possible identifiers:
    modelId: modelRow?.db_id ?? undefined,
    modelKey: modelRow?.key ?? undefined,
    model: modelRow?.model_name ?? selectedVal, // fallback to model_name or the selected string
    conversation_id: state.sessionId,
    messages: [
      { role: 'system', content: systemPrompt },
      ...state.chatHistory,
      { role: 'user', content: message }
    ],
    max_tokens: 2000,
    stream: false
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    // Try to surface the Gateway error clearly
    let errText = 'LLM request failed';
    try {
      const j = await response.json();
      errText = j.error || errText;
    } catch {}
    throw new Error(errText);
  }

  const data = await response.json();
  const aiResponse = data.content || data.response || data?.choices?.[0]?.message?.content || '';

  state.chatHistory.push(
    { role: 'user', content: message },
    { role: 'assistant', content: aiResponse }
  );

  return aiResponse;
}



function addChatMessage(role, content, isError = false, isRaw = false) {
  const messagesContainer = document.getElementById('chat-messages');
  const messageId = `msg-${Date.now()}`;

  const message = document.createElement('div');
  message.id = messageId;
  message.className = `message ${role}`;

  const avatar = role === 'user' ? 'You' : 'AI';
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const formatted = isRaw ? content : formatMarkdown(content);

  message.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div>
      <div class="message-content ${isError ? 'alert-error' : ''}">${formatted}</div>
      <div class="message-metadata">${time}</div>
    </div>
  `;

  messagesContainer.appendChild(message);
  messagesContainer.scrollTop = messagesContainer.scrollHeight;

  return messageId;
}


function formatMarkdown(text) {
    // Simple markdown formatting
    let formatted = escapeHtml(text);
    
    // Code blocks
    formatted = formatted.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    
    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Line breaks
    formatted = formatted.replace(/\n/g, '<br>');
    
    return formatted;
}

// GitHub Integration
async function analyzeIssue() {
    const repoSelect = document.getElementById('issue-repo');
    const repo = repoSelect.value;
    const issueNumber = document.getElementById('issue-number').value.trim();
    
    if (!repo || !issueNumber) {
        showAlert('Please select repository and enter issue number', 'error');
        return;
    }
    
    const btn = document.getElementById('analyze-issue-btn');
    btn.disabled = true;
    btn.innerHTML = '<div class="loading"><div class="spinner"></div><span>Analyzing...</span></div>';
    
    try {
        const response = await fetch(`${CONFIG.CODE_SLICER_URL}/from-issue`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo,
                issue_number: parseInt(issueNumber),
                context: 15
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Analysis failed');
        }
        
        const data = await response.json();
        displayGitHubResults(data, `Issue #${issueNumber}`);
        showAlert('Issue analysis complete!', 'success');
        
    } catch (error) {
        showAlert(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔍</span> Analyze Issue';
    }
}

async function analyzePR() {
    const repoSelect = document.getElementById('pr-repo');
    const repo = repoSelect.value;
    const prNumber = document.getElementById('pr-number').value.trim();
    
    if (!repo || !prNumber) {
        showAlert('Please select repository and enter PR number', 'error');
        return;
    }
    
    const btn = document.getElementById('analyze-pr-btn');
    btn.disabled = true;
    btn.innerHTML = '<div class="loading"><div class="spinner"></div><span>Analyzing...</span></div>';
    
    try {
        const response = await fetch(`${CONFIG.CODE_SLICER_URL}/from-pr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                repo,
                pr_number: parseInt(prNumber),
                context: 15,
                analyze_impact: true
            })
        });
        
        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Analysis failed');
        }
        
        const data = await response.json();
        displayGitHubResults(data, `PR #${prNumber}`);
        showAlert('PR analysis complete!', 'success');
        
    } catch (error) {
        showAlert(`Error: ${error.message}`, 'error');
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔍</span> Analyze PR';
    }
}

async function compareBranches() {
  const repoSelect = document.getElementById('compare-repo');
  const baseBranchSelect = document.getElementById('base-branch');
  const compareBranchSelect = document.getElementById('compare-branch');
  const repo = repoSelect.value;
  const baseBranch = baseBranchSelect.value;
  const compareBranch = compareBranchSelect.value;

  if (!repo || !baseBranch || !compareBranch) {
    showAlert('Please select repository and both branches', 'error');
    return;
  }

  const btn = document.getElementById('compare-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="loading"><div class="spinner"></div><span>Comparing...</span></div>';

  try {
    const body = {
      repo,
      base_branch: baseBranch,
      compare_branch: compareBranch,
      context: 15,
      analyze_changes: true
    };

    const connId = repoSelect.selectedOptions[0]?.dataset.connId;
    if (connId) body.conn_id = connId;

    const response = await fetch(`${CONFIG.CODE_SLICER_URL}/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Comparison failed');
    }

    const data = await response.json();
    displayGitHubResults(data, `${baseBranch} vs ${compareBranch}`);
    showAlert('Branch comparison complete!', 'success');

  } catch (error) {
    showAlert(`Error: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>🔍</span> Compare Branches';
  }
}

function displayGitHubResults(data, title) {
  const resultsSection = document.getElementById('github-results');
  const statsContainer = document.getElementById('github-result-stats');
  const codeContent = document.getElementById('github-code-content');

  resultsSection.style.display = 'block';

  const stats = [];

  if (data.issue_number) {
    stats.push({ label: 'Issue', value: `#${data.issue_number}` });
    stats.push({ label: 'Targets Found', value: data.extracted_targets?.length || 0 });
  }

  if (data.pr_number) {
    stats.push({ label: 'Pull Request', value: `#${data.pr_number}` });
    stats.push({ label: 'Files Changed', value: data.changed_files || 0 });
  }

  if (data.comparison) {
    stats.push({ label: 'Ahead By', value: data.comparison.ahead_by });
    stats.push({ label: 'Behind By', value: data.comparison.behind_by });
    stats.push({ label: 'Files Changed', value: data.comparison.files_changed });
  }

  stats.push({ label: 'Branch', value: data.branch || 'default' });

  statsContainer.innerHTML = stats.map(stat => `
    <div class="stat">
      <div class="stat-label">${stat.label}</div>
      <div class="stat-value">${stat.value}</div>
    </div>
  `).join('');

  codeContent.textContent = data.markdown || JSON.stringify(data, null, 2);
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Simple “Branches” helper (still uses Code Slicer helper if present)
async function listBranches() {
  const repoSelect = document.getElementById('branches-repo');
  const repo = repoSelect.value;

  if (!repo) {
    showAlert('Please select a repository', 'error');
    return;
  }

  const connId = repoSelect.selectedOptions[0]?.dataset.connId;

  const btn = document.getElementById('list-branches-btn');
  btn.disabled = true;
  btn.innerHTML = '<div class="loading"><div class="spinner"></div><span>Loading...</span></div>';

  try {
    // Prefer hitting GitHub Hub directly via the server proxy
    let branches = [];
    if (connId) {
      const r = await fetch(`${CONFIG.GITHUB_HUB_URL}/${encodeURIComponent(connId)}/branches`);
      if (r.ok) {
        const data = await r.json();
        branches = data.branches || [];
      }
    }

    // Fallback to Code Slicer helper if needed/desired
    if (branches.length === 0) {
      const [owner, repoName] = repo.split('/');
      const response = await fetch(`${CONFIG.CODE_SLICER_URL}/branches/${owner}/${repoName}`);
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to fetch branches');
      }
      const data = await response.json();
      branches = data.branches || [];
    }

    displayBranches(branches);
    showAlert(`Found ${branches.length} branches`, 'success');

  } catch (error) {
    showAlert(`Error: ${error.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span>📋</span> List Branches';
  }
}

function displayBranches(branches) {
  const resultsSection = document.getElementById('branches-results');
  const branchCount = document.getElementById('branch-count');
  const branchList = document.getElementById('branch-list');

  resultsSection.style.display = 'block';
  branchCount.textContent = `${branches.length} branches`;

  branchList.innerHTML = branches.map(branch => `
    <div class="branch-item" data-branch="${escapeHtml(branch)}">
      ${escapeHtml(branch)}
    </div>
  `).join('');

  branchList.querySelectorAll('.branch-item').forEach(item => {
    item.addEventListener('click', () => {
      const branch = item.dataset.branch;

      const activeTab = document.querySelector('.tab.active').dataset.tab;
      if (activeTab === 'manual') {
        document.getElementById('branch').value = branch;
      } else if (activeTab === 'ai-chat') {
        document.getElementById('chat-branch').value = branch;
      }

      branchList.querySelectorAll('.branch-item').forEach(i => i.classList.remove('selected'));
      item.classList.add('selected');

      showAlert(`Selected branch: ${branch}`, 'info');
    });
  });

  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  setInterval(checkHealth, 30000);

  loadRepositories();
  loadModels();

  initTabs();

  initTagInput('targets-container', 'target-input', state.targets);
  initTagInput('hints-container', 'hint-input', state.hints);

  // Repository change handlers
  document.getElementById('repo')?.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && e.target.value) {
      state.selectedRepo = e.target.value;
      state.selectedConnId = opt.dataset.connId || null;

      // keep default branch for fallback
      const branchEl = document.getElementById('branch');
      if (branchEl) branchEl.dataset.defaultBranch = opt.dataset.defaultBranch || 'main';

      loadBranches(e.target.value, 'branch', state.selectedConnId);

      // also update hidden/visible conn-id input if present
      const connIdInput = document.getElementById('conn-id');
      if (connIdInput) connIdInput.value = state.selectedConnId || '';
    }
  });

  document.getElementById('chat-repo')?.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && e.target.value) {
      state.selectedRepo = e.target.value;
      state.selectedConnId = opt.dataset.connId || null;

      const branchEl = document.getElementById('chat-branch');
      if (branchEl) branchEl.dataset.defaultBranch = opt.dataset.defaultBranch || 'main';

      loadBranches(e.target.value, 'chat-branch', state.selectedConnId);
    }
  });

  document.getElementById('compare-repo')?.addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    if (opt && e.target.value) {
      const connId = opt.dataset.connId || null;
      loadBranches(e.target.value, 'base-branch', connId);
      loadBranches(e.target.value, 'compare-branch', connId);
    }
  });

  // Model change handler
  document.getElementById('chat-model')?.addEventListener('change', (e) => {
    state.selectedModel = e.target.value;
  });

  // Manual analysis
  document.getElementById('analyze-btn').addEventListener('click', analyzeCode);
  document.getElementById('clear-btn').addEventListener('click', clearForm);
  document.getElementById('copy-markdown-btn').addEventListener('click', copyMarkdown);

  // AI Chat
  document.getElementById('chat-form').addEventListener('submit', sendChatMessage);

  const chatInput = document.getElementById('chat-input');
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = chatInput.scrollHeight + 'px';
  });

  // GitHub Integration
  document.getElementById('analyze-issue-btn').addEventListener('click', analyzeIssue);
  document.getElementById('analyze-pr-btn').addEventListener('click', analyzePR);
  document.getElementById('compare-btn').addEventListener('click', compareBranches);

  // Branches
  document.getElementById('list-branches-btn').addEventListener('click', listBranches);
});