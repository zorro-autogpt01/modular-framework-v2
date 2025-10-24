// 🆕 NEW FILE: public/js/analysis.js

let currentAnalysis = null;

export async function initAnalysis() {
  const analyzeBtn = document.getElementById('analyzeBtn');
  const forceAnalyzeBtn = document.getElementById('forceAnalyzeBtn');
  const analysisPanel = document.getElementById('analysisPanel');
  
  // Show analysis panel when repo is loaded
  const observer = new MutationObserver(() => {
    if (window.ACTIVE_REPO) {
      analysisPanel.style.display = 'block';
      tryLoadCachedAnalysis();
    }
  });
  
  analyzeBtn?.addEventListener('click', () => runAnalysis(false));
  forceAnalyzeBtn?.addEventListener('click', () => runAnalysis(true));
}

async function tryLoadCachedAnalysis() {
  if (!window.ACTIVE_REPO) return;
  
  const { owner, repo } = parseRepoUrl(window.ACTIVE_REPO);
  
  try {
    const response = await fetch(`/api/cache/${owner}/${repo}`);
    if (response.ok) {
      const data = await response.json();
      displayAnalysisResults(data);
    }
  } catch (err) {
    console.log('No cached analysis found');
  }
}

async function runAnalysis(force = false) {
  if (!window.ACTIVE_REPO) {
    showToast('No repository loaded', 'error');
    return;
  }
  
  const { owner, repo } = parseRepoUrl(window.ACTIVE_REPO);
  const analyzeBtn = document.getElementById('analyzeBtn');
  const forceAnalyzeBtn = document.getElementById('forceAnalyzeBtn');
  
  analyzeBtn.disabled = true;
  forceAnalyzeBtn.disabled = true;
  analyzeBtn.textContent = 'Analyzing...';
  
  try {
    const response = await fetch(`/api/analyze/${owner}/${repo}?force=${force}`, {
      method: 'POST'
    });
    
    if (!response.ok) throw new Error('Analysis failed');
    
    const data = await response.json();
    currentAnalysis = data;
    displayAnalysisResults(data);
    
    showToast(data.cached ? 'Loaded from cache' : 'Analysis complete!', 'success');
    
    // Enhance tree with analysis data
    enhanceTreeWithAnalysis(data);
    
  } catch (err) {
    showToast(`Analysis failed: ${err.message}`, 'error');
  } finally {
    analyzeBtn.disabled = false;
    forceAnalyzeBtn.disabled = false;
    analyzeBtn.textContent = 'Analyze Repository';
  }
}

function displayAnalysisResults(data) {
  const resultsDiv = document.getElementById('analysisResults');
  resultsDiv.style.display = 'block';
  
  // Update stats
  document.getElementById('statFiles').textContent = 
    data.dependencies.stats.total_files.toLocaleString();
  document.getElementById('statDeps').textContent = 
    data.dependencies.stats.total_dependencies.toLocaleString();
  document.getElementById('statTokens').textContent = 
    data.tokens.totals.tokens.toLocaleString();
  document.getElementById('statLines').textContent = 
    data.tokens.totals.lines.toLocaleString();
  
  // Show circular dependencies if any
  if (data.circular_dependencies && data.circular_dependencies.length > 0) {
    const circularDiv = document.getElementById('circularDeps');
    const circularList = document.getElementById('circularList');
    circularDiv.style.display = 'block';
    
    const displayCount = Math.min(3, data.circular_dependencies.length);
    circularList.innerHTML = data.circular_dependencies
      .slice(0, displayCount)
      .map(circle => circle.join(' → '))
      .join('<br>');
    
    if (data.circular_dependencies.length > 3) {
      circularList.innerHTML += `<br><span style="opacity: 0.7;">... and ${data.circular_dependencies.length - 3} more</span>`;
    }
  }
  
  // Show analysis time
  if (data.metadata?.analyzed_at) {
    const time = new Date(data.metadata.analyzed_at).toLocaleString();
    document.getElementById('analysisTime').textContent = 
      `Last analyzed: ${time}${data.cached ? ' (cached)' : ''}`;
  }
}

function enhanceTreeWithAnalysis(data) {
  // Add token badges and dependency indicators to tree
  const treeItems = document.querySelectorAll('.tree-item');
  
  treeItems.forEach(item => {
    const path = item.dataset.path;
    if (!path) return;
    
    // Remove existing badges
    item.querySelectorAll('.token-badge, .dep-indicator').forEach(el => el.remove());
    
    // Add token badge
    const tokenData = data.tokens.files[path];
    if (tokenData) {
      const badge = document.createElement('span');
      badge.className = 'token-badge ' + getTokenCategory(tokenData.tokens);
      badge.textContent = tokenData.tokens.toLocaleString();
      badge.title = `${tokenData.tokens} tokens, ${tokenData.lines} lines`;
      item.querySelector('.tree-name')?.appendChild(badge);
    }
    
    // Add dependency indicator
    const deps = data.dependencies.dependencies[path] || [];
    const usedBy = data.dependencies.reverse_dependencies[path] || [];
    
    if (deps.length > 0 || usedBy.length > 0) {
      const indicator = document.createElement('span');
      indicator.className = 'dep-indicator';
      
      if (deps.length > 0) {
        indicator.innerHTML += `→ ${deps.length}`;
        indicator.title = `Imports ${deps.length} files`;
      }
      if (usedBy.length > 0) {
        indicator.innerHTML += ` ← ${usedBy.length}`;
        indicator.title = `Used by ${usedBy.length} files`;
      }
      
      item.querySelector('.tree-name')?.appendChild(indicator);
    }
  });
}

function getTokenCategory(tokens) {
  if (tokens < 500) return 'small';
  if (tokens < 2000) return 'medium';
  if (tokens < 8000) return 'large';
  return 'very-large';
}

function parseRepoUrl(url) {
  // Parse owner/repo from URL
  const match = url.match(/github\.com[/:]([\w-]+)\/([\w-]+)/);
  if (match) {
    return { owner: match[1], repo: match[2].replace('.git', '') };
  }
  throw new Error('Invalid repo URL');
}

function showToast(message, type = 'info') {
  // Reuse existing toast function from app.js
  if (window.showToast) {
    window.showToast(message, type);
  } else {
    console.log(`[${type}] ${message}`);
  }
}