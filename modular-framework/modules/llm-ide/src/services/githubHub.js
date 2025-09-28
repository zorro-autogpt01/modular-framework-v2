// src/services/githubHub.js
import { showNotification } from '../ui/notifications.js';
import { bus } from '../core/eventBus.js';
import { state } from '../core/state.js';

class GitHubHubService {
  constructor() {
    this.baseUrl = this.detectBaseUrl();
    this.config = null;
    this.connected = false;
  }

  detectBaseUrl() {
   const { protocol, host, pathname } = window.location;
   // Allow an explicit override (handy for prod)
   const override = window.GITHUB_HUB_BASE
     || document.querySelector('meta[name="github-hub-base"]')?.content;
   if (override) return override.replace(/\/$/, '');

   // Prefer the framework proxy on the same host
   // (works whether IDE is on :3020 or another port)
   //return `${protocol}//${host.replace(/:3020$/, ':8080')}/api/github-hub`;
   return `${protocol}//${host}/api/github-hub`;
  }

  async checkConnection() {
    try {
      const res = await fetch(`${this.baseUrl}/api/config`);
      if (!res.ok) throw new Error('GitHub Hub not available');
      
      this.config = await res.json();
      this.connected = !!this.config.repo_url;
      
      if (this.connected) {
        // Parse repo name from URL for display
        const repoName = this.config.repo_url.split('/').slice(-2).join('/').replace('.git', '');
        showNotification(`✅ Connected to GitHub Hub: ${repoName}`, 'success');
        bus.emit('github:hub:connected', { config: this.config, repoName });
      }
      
      return this.config;
    } catch (e) {
      this.connected = false;
      console.warn('GitHub Hub not available:', e);
      return null;
    }
  }

  async getBranches() {
    if (!this.connected) throw new Error('GitHub Hub not configured');
    const res = await fetch(`${this.baseUrl}/api/branches`);
    if (!res.ok) throw new Error('Failed to fetch branches');
    return res.json();
  }

  async getTree(branch = null, path = null, recursive = true) {
    if (!this.connected) throw new Error('GitHub Hub not configured');
    const params = new URLSearchParams({ recursive: String(recursive) });
    if (branch) params.append('branch', branch);
    if (path) params.append('path', path);
    
    const res = await fetch(`${this.baseUrl}/api/tree?${params}`);
    if (!res.ok) throw new Error('Failed to fetch tree');
    return res.json();
  }

  async getFile(path, branch = null) {
    if (!this.connected) throw new Error('GitHub Hub not configured');
    const params = new URLSearchParams({ path });
    if (branch) params.append('branch', branch);
    
    const res = await fetch(`${this.baseUrl}/api/file?${params}`);
    if (!res.ok) throw new Error('Failed to fetch file');
    return res.json();
  }

  async saveFile(path, content, message, branch = null, sha = null) {
    if (!this.connected) throw new Error('GitHub Hub not configured');
    
    const body = { path, content, message };
    if (branch) body.branch = branch;
    if (sha) body.sha = sha;
    
    const res = await fetch(`${this.baseUrl}/api/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    if (!res.ok) throw new Error('Failed to save file');
    return res.json();
  }

  async deleteFile(path, message, sha, branch = null) {
    if (!this.connected) throw new Error('GitHub Hub not configured');
    
    const params = new URLSearchParams({ path, message, sha });
    if (branch) params.append('branch', branch);
    
    const res = await fetch(`${this.baseUrl}/api/file?${params}`, {
      method: 'DELETE'
    });
    
    if (!res.ok) throw new Error('Failed to delete file');
    return res.json();
  }

  async createBranch(newBranch, baseBranch = 'main') {
    if (!this.connected) throw new Error('GitHub Hub not configured');
    
    const params = new URLSearchParams({ 
      new: newBranch,
      from: baseBranch 
    });
    
    const res = await fetch(`${this.baseUrl}/api/branch?${params}`, {
      method: 'POST'
    });
    
    if (!res.ok) throw new Error('Failed to create branch');
    return res.json();
  }

  async batchCommit(branch, message, changes) {
    if (!this.connected) throw new Error('GitHub Hub not configured');
    
    const res = await fetch(`${this.baseUrl}/api/batch/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch, message, changes })
    });
    
    if (!res.ok) throw new Error('Failed to batch commit');
    return res.json();
  }

  // Convert GitHub tree format to IDE file tree format
  convertTreeToFileTree(items, currentPath = '') {
    const tree = {};
    
    items.forEach(item => {
      const parts = item.path.split('/');
      let current = tree;
      
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        
        if (isLast) {
          if (item.type === 'tree') {
            current[part] = { type: 'folder', children: {} };
          } else {
            current[part] = { 
              type: 'file', 
              size: item.size,
              sha: item.sha,
              // Content will be loaded on demand
              content: null 
            };
          }
        } else {
          if (!current[part]) {
            current[part] = { type: 'folder', children: {} };
          }
          current = current[part].children;
        }
      }
    });
    
    return tree;
  }

  async loadGitHubTree(branch = null) {
    try {
      showNotification('🔄 Loading GitHub repository tree...', 'info');
      const treeData = await this.getTree(branch);
      const fileTree = this.convertTreeToFileTree(treeData.items || []);
      
      state.fileTree = fileTree;
      state.currentWorkspace = 'github';
      
      bus.emit('fileTree:replace', { tree: fileTree });
      showNotification('✅ GitHub tree loaded', 'success');
      
      return fileTree;
    } catch (e) {
      showNotification(`❌ Failed to load GitHub tree: ${e.message}`, 'error');
      throw e;
    }
  }

  async syncFileContent(path) {
    try {
      const fileData = await this.getFile(path);
      const fileNode = this.getFileNode(path, state.fileTree);
      
      if (fileNode) {
        fileNode.content = fileData.decoded_content || '';
        fileNode.sha = fileData.sha;
      }
      
      return fileData.decoded_content || '';
    } catch (e) {
      console.error('Failed to sync file content:', e);
      throw e;
    }
  }

  getFileNode(path, tree = state.fileTree) {
    const parts = path.split('/');
    let current = tree;
    
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      
      if (!current[part]) return null;
      
      if (isLast) {
        return current[part];
      } else if (current[part].type === 'folder') {
        current = current[part].children;
      } else {
        return null;
      }
    }
    
    return null;
  }

  // Track modified files for batch operations
  trackModifiedFile(path, content, originalContent) {
    if (!state.githubModified) state.githubModified = new Map();
    
    if (content !== originalContent) {
      state.githubModified.set(path, { content, originalContent });
    } else {
      state.githubModified.delete(path);
    }
    
    bus.emit('github:files:modified', { 
      count: state.githubModified.size,
      files: Array.from(state.githubModified.keys())
    });
  }

  async commitModifiedFiles(message, branch = null) {
    if (!state.githubModified || state.githubModified.size === 0) {
      showNotification('⚠️ No modified files to commit', 'warning');
      return;
    }
    
    const changes = [];
    for (const [path, data] of state.githubModified) {
      changes.push({
        path,
        content: data.content,
        mode: '100644'
      });
    }
    
    try {
      showNotification(`📦 Committing ${changes.length} files...`, 'info');
      const result = await this.batchCommit(
        branch || this.config.default_branch || 'main',
        message,
        changes
      );
      
      // Clear modified tracking
      state.githubModified.clear();
      bus.emit('github:files:modified', { count: 0, files: [] });
      
      showNotification(`✅ Committed successfully: ${result.commit_sha?.slice(0, 7)}`, 'success');
      return result;
    } catch (e) {
      showNotification(`❌ Commit failed: ${e.message}`, 'error');
      throw e;
    }
  }
}

// Create and export singleton instance
export const githubHub = new GitHubHubService();

// Auto-initialize on load
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => githubHub.checkConnection(), 1000);
  });
}

// Enhanced Git command handlers that work with both SSH and GitHub Hub
export const gitHandlers = {
  'git:add': () => {
    if (state.currentWorkspace === 'github') {
      showNotification('📦 Files are automatically tracked in GitHub mode', 'info');
    } else {
      const cmd = 'git add .';
      window.AdvancedCodeEditorAPI?.API?.executeRemoteCommand(cmd);
      showNotification('📦 Staging all changes...', 'info');
    }
  },
  
  'git:commit': async () => {
    const msg = document.getElementById('commitMessage')?.value;
    if (!msg) {
      showNotification('⚠️ Please enter a commit message', 'warning');
      return;
    }
    
    if (state.currentWorkspace === 'github') {
      await githubHub.commitModifiedFiles(msg);
    } else {
      const cmd = `git commit -m "${msg.replace(/"/g, '\\"')}"`;
      window.AdvancedCodeEditorAPI?.API?.executeRemoteCommand(cmd);
    }
    
    document.getElementById('commitMessage').value = '';
  },
  
  'git:push': async () => {
    if (state.currentWorkspace === 'github') {
      showNotification('ℹ️ GitHub mode commits are automatically pushed', 'info');
    } else {
      const branch = document.getElementById('branchSelector')?.value || 'main';
      const cmd = `git push origin ${branch}`;
      window.AdvancedCodeEditorAPI?.API?.executeRemoteCommand(cmd);
      showNotification('⬆️ Pushing changes...', 'info');
    }
  },
  
  'git:pull': async () => {
    if (state.currentWorkspace === 'github') {
      // In GitHub mode, reload the tree
      await githubHub.loadGitHubTree();
    } else {
      const cmd = 'git pull origin main';
      window.AdvancedCodeEditorAPI?.API?.executeRemoteCommand(cmd);
    }
  },
  
  'git:status': () => {
    if (state.currentWorkspace === 'github') {
      const count = state.githubModified?.size || 0;
      showNotification(`📊 ${count} file(s) modified`, 'info');
    } else {
      const cmd = 'git status';
      window.AdvancedCodeEditorAPI?.API?.executeRemoteCommand(cmd);
    }
  },
  
  'github:browse': async () => {
    await githubHub.loadGitHubTree();
  },
  
  'github:sync': async () => {
    if (!state.activeFile) {
      showNotification('⚠️ No file open to sync', 'warning');
      return;
    }
    
    try {
      const content = await githubHub.syncFileContent(state.activeFile);
      
      // Update editor if this is the active file
      if (state.editor && state.activeFile) {
        state.editor.setValue(content);
      }
      
      showNotification(`✅ Synced: ${state.activeFile}`, 'success');
    } catch (e) {
      showNotification(`❌ Sync failed: ${e.message}`, 'error');
    }
  },
  
  'github:create-branch': async () => {
    const newBranch = prompt('Enter new branch name:');
    if (!newBranch) return;
    
    const baseBranch = document.getElementById('branchSelector')?.value || 'main';
    
    try {
      await githubHub.createBranch(newBranch, baseBranch);
      showNotification(`✅ Created branch: ${newBranch}`, 'success');
      
      // Refresh branches
      const branches = await githubHub.getBranches();
      updateBranchSelector(branches.branches);
    } catch (e) {
      showNotification(`❌ Failed to create branch: ${e.message}`, 'error');
    }
  }
};

function updateBranchSelector(branches) {
  const selector = document.getElementById('branchSelector');
  if (!selector) return;
  
  const current = selector.value;
  selector.innerHTML = '';
  
  branches.forEach(branch => {
    const option = document.createElement('option');
    option.value = branch;
    option.textContent = branch;
    if (branch === current) option.selected = true;
    selector.appendChild(option);
  });
}