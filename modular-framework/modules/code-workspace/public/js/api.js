// API Service for Code Workspace (fixed for Nginx proxied paths)

(function () {
  const WORKSPACE_BASE = '/api/v1/code-workspace/api'; // <-- proxied base via Nginx
  const GITHUB_HUB_BASE = '/api/v1/github/api';        // <-- proxied GitHub Hub

  async function parseJSONorThrow(response) {
    const ct = response.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      // Likely HTML (SPA) or other content — read a small chunk for error hint
      const text = await response.text();
      const snippet = text.slice(0, 200);
      throw new Error(`Unexpected response (content-type: ${ct}). First bytes: ${snippet}`);
    }
    return response.json();
  }

  async function requestJSON(url, options = {}) {
    const defaultOptions = {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    };
    const resp = await fetch(url, { ...defaultOptions, ...options });
    if (!resp.ok) {
      // Try to parse JSON error, otherwise throw status
      try {
        const data = await resp.json();
        const msg = data?.error || data?.message || `${resp.status} ${resp.statusText}`;
        throw new Error(msg);
      } catch {
        throw new Error(`${resp.status} ${resp.statusText}`);
      }
    }
    return parseJSONorThrow(resp);
  }

  async function requestBlob(url, options = {}) {
    const defaultOptions = { credentials: 'include' };
    const resp = await fetch(url, { ...defaultOptions, ...options });
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
    return resp.blob();
  }

  // Helper to build query string safely
  function qs(params = {}) {
    const u = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) u.append(k, String(v));
    });
    return u.toString();
  }

  const API = {
    // ---------------------------
    // Repositories (workspace svc)
    // ---------------------------
    repos: {
      list() {
        return requestJSON(`${WORKSPACE_BASE}/repos`);
      },

      clone(data) {
        return requestJSON(`${WORKSPACE_BASE}/repos/clone`, {
          method: 'POST',
          body: JSON.stringify(data),
        });
      },

      delete(connection_id, repo_name) {
        return requestJSON(`${WORKSPACE_BASE}/repos/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'DELETE',
        });
      },

      status(connection_id, repo_name) {
        return requestJSON(`${WORKSPACE_BASE}/repos/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/status`);
      },

      fetch(connection_id, repo_name, all = true) {
        return requestJSON(`${WORKSPACE_BASE}/repos/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/fetch`, {
          method: 'POST',
          body: JSON.stringify({ all }),
        });
      },
    },

    // ------------
    // Git operations
    // ------------
    git: {
      diff(connection_id, repo_name, file = null, staged = false) {
        const query = qs({ file, staged });
        return requestJSON(`${WORKSPACE_BASE}/git/diff/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}?${query}`);
      },

      stage(connection_id, repo_name, files = ['.']) {
        return requestJSON(`${WORKSPACE_BASE}/git/stage/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify({ files }),
        });
      },

      unstage(connection_id, repo_name, files = []) {
        return requestJSON(`${WORKSPACE_BASE}/git/unstage/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify({ files }),
        });
      },

      commit(connection_id, repo_name, data) {
        return requestJSON(`${WORKSPACE_BASE}/git/commit/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify(data),
        });
      },

      pull(connection_id, repo_name, options = {}) {
        return requestJSON(`${WORKSPACE_BASE}/git/pull/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify(options),
        });
      },

      push(connection_id, repo_name, options = {}) {
        return requestJSON(`${WORKSPACE_BASE}/git/push/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify(options),
        });
      },

      branches(connection_id, repo_name) {
        return requestJSON(`${WORKSPACE_BASE}/git/branches/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`);
      },

      createBranch(connection_id, repo_name, name, from = 'HEAD', checkout = true, push = false) {
        return requestJSON(`${WORKSPACE_BASE}/git/branches/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify({ name, from, checkout, push }),
        });
      },

      checkout(connection_id, repo_name, branch, create = false) {
        return requestJSON(`${WORKSPACE_BASE}/git/checkout/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify({ branch, create }),
        });
      },

      merge(connection_id, repo_name, from, into = null, preview = false, no_ff = false) {
        return requestJSON(`${WORKSPACE_BASE}/git/merge/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify({ from, into, preview, no_ff }),
        });
      },
    },

    // -----------------
    // Workspace (files)
    // -----------------
    workspace: {
      browse(connection_id, repo_name, path = '', depth = 1) {
        const query = qs({ path, depth });
        return requestJSON(`${WORKSPACE_BASE}/workspace/browse/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}?${query}`);
      },

      readFile(connection_id, repo_name, filePath) {
        // ✅ FIXED: Put filePath in URL, not query parameter
        return requestJSON(`${WORKSPACE_BASE}/workspace/file/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/${filePath}`);
      },

      writeFile(connection_id, repo_name, filePath, content, encoding = 'utf8') {
        return requestJSON(`${WORKSPACE_BASE}/workspace/file/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/${filePath}`, {
          method: 'PUT',
          body: JSON.stringify({ content, encoding }),
        });
      },

      createFile(connection_id, repo_name, filePath, content = '') {
        return requestJSON(`${WORKSPACE_BASE}/workspace/file/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/${filePath}`, {
          method: 'POST',
          body: JSON.stringify({ content }),
        });
      },

      deleteFile(connection_id, repo_name, filePath) {
        return requestJSON(`${WORKSPACE_BASE}/workspace/file/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/${filePath}`, {
          method: 'DELETE',
        });
      },

      rename(connection_id, repo_name, from, to) {
        return requestJSON(`${WORKSPACE_BASE}/workspace/rename/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify({ from, to }),
        });
      },

      search(connection_id, repo_name, queryText, options = {}) {
        return requestJSON(`${WORKSPACE_BASE}/workspace/search/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`, {
          method: 'POST',
          body: JSON.stringify({ query: queryText, ...options }),
        });
      },
    },

    // --------------------
    // History / Snapshots
    // --------------------
    history: {
      list(connection_id, repo_name, file = null, limit = 50, offset = 0) {
        const query = qs({ file, limit, offset });
        return requestJSON(`${WORKSPACE_BASE}/history/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}?${query}`);
      },

      create(connection_id, repo_name, type = 'manual', description = '', files = []) {
        return requestJSON(`${WORKSPACE_BASE}/history/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/snapshot`, {
          method: 'POST',
          body: JSON.stringify({ type, description, files }),
        });
      },

      get(connection_id, repo_name, snapshot_id) {
        return requestJSON(`${WORKSPACE_BASE}/history/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/snapshot/${encodeURIComponent(snapshot_id)}`);
      },

      restore(connection_id, repo_name, snapshot_id, files = [], overwrite = true) {
        return requestJSON(`${WORKSPACE_BASE}/history/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/snapshot/${encodeURIComponent(snapshot_id)}/restore`, {
          method: 'POST',
          body: JSON.stringify({ files, overwrite }),
        });
      },

      compare(connection_id, repo_name, from, to, file = null) {
        const query = qs({ from, to, file });
        return requestJSON(`${WORKSPACE_BASE}/history/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/compare?${query}`);
      },

      delete(connection_id, repo_name, snapshot_id) {
        return requestJSON(`${WORKSPACE_BASE}/history/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/snapshot/${encodeURIComponent(snapshot_id)}`, {
          method: 'DELETE',
        });
      },
    },

    // ----------
    // File locks
    // ----------
    locks: {
      list(connection_id, repo_name) {
        return requestJSON(`${WORKSPACE_BASE}/locks/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}`);
      },

      acquire(connection_id, repo_name, file, owner, container_id = 'web', ttl = 3600) {
        return requestJSON(`${WORKSPACE_BASE}/locks/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/acquire`, {
          method: 'POST',
          body: JSON.stringify({ file, owner, container_id, ttl }),
        });
      },

      release(connection_id, repo_name, file, owner) {
        return requestJSON(`${WORKSPACE_BASE}/locks/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/release`, {
          method: 'DELETE',
          body: JSON.stringify({ file, owner }),
        });
      },

      check(connection_id, repo_name, file) {
        return requestJSON(`${WORKSPACE_BASE}/locks/${encodeURIComponent(connection_id)}/${encodeURIComponent(repo_name)}/check/${encodeURIComponent(file)}`);
      },
    },

    // --------
    // AI routes
    // --------
    ai: {
      tokenize(connection_id, repo_name, files, model = 'gpt-4o') {
        return requestJSON(`${WORKSPACE_BASE}/ai/tokenize`, {
          method: 'POST',
          body: JSON.stringify({ connection_id, repo_name, files, model }),
        });
      },

      generateCommitMessage(connection_id, repo_name, style = 'conventional') {
        return requestJSON(`${WORKSPACE_BASE}/ai/generate-commit-message`, {
          method: 'POST',
          body: JSON.stringify({ connection_id, repo_name, style }),
        });
      },

      analyzePush(connection_id, repo_name, branch = 'main') {
        return requestJSON(`${WORKSPACE_BASE}/ai/analyze-push`, {
          method: 'POST',
          body: JSON.stringify({ connection_id, repo_name, branch }),
        });
      },

      summarizePull(connection_id, repo_name, commits, files_changed) {
        return requestJSON(`${WORKSPACE_BASE}/ai/summarize-pull`, {
          method: 'POST',
          body: JSON.stringify({ connection_id, repo_name, commits, files_changed }),
        });
      },

      resolveConflict(file_content, ours_name = 'current', theirs_name = 'incoming', context = '') {
        return requestJSON(`${WORKSPACE_BASE}/ai/resolve-conflict`, {
          method: 'POST',
          body: JSON.stringify({ file_content, ours_name, theirs_name, context }),
        });
      },

      suggestFiles(connection_id, repo_name, query, max_files = 10) {
        return requestJSON(`${WORKSPACE_BASE}/ai/suggest-files`, {
          method: 'POST',
          body: JSON.stringify({ connection_id, repo_name, query, max_files }),
        });
      },
    },

    // ---------
    // Settings
    // ---------
    settings: {
      get() {
        return requestJSON(`${WORKSPACE_BASE}/settings`);
      },

      update(settings) {
        return requestJSON(`${WORKSPACE_BASE}/settings`, {
          method: 'PUT',
          body: JSON.stringify(settings),
        });
      },

      reset(section = null) {
        return requestJSON(`${WORKSPACE_BASE}/settings/reset`, {
          method: 'POST',
          body: JSON.stringify({ section }),
        });
      },

      export() {
        return requestBlob(`${WORKSPACE_BASE}/settings/export`);
      },

      import(settings) {
        return requestJSON(`${WORKSPACE_BASE}/settings/import`, {
          method: 'POST',
          body: JSON.stringify(settings),
        });
      },

      testLLM(url = null, model = 'gpt-4o') {
        return requestJSON(`${WORKSPACE_BASE}/settings/test/llm`, {
          method: 'POST',
          body: JSON.stringify({ url, model }),
        });
      },

      testGitHub(url = null) {
        return requestJSON(`${WORKSPACE_BASE}/settings/test/github-hub`, {
          method: 'POST',
          body: JSON.stringify({ url }),
        });
      },
    },

    // -----------------------
    // GitHub Hub integration
    // -----------------------
    githubHub: {
      async getConnections() {
        // Use WORKSPACE_BASE since these are proxy routes in code-workspace backend
        const response = await fetch(`${WORKSPACE_BASE}/github-hub/connections`);
        if (!response.ok) {
          throw new Error('Failed to fetch connections');
        }
        const data = await response.json();
        
        // github-hub returns: { default_id: "...", connections: [...] }
        // Extract just the connections array
        return data.connections || [];
      },
      
      async getConnection(connectionId) {
        const response = await fetch(`${WORKSPACE_BASE}/github-hub/connections/${connectionId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch connection details');
        }
        return response.json();
      },
      
      async getBranches(connectionId) {
        const response = await fetch(`${WORKSPACE_BASE}/github-hub/branches?conn_id=${connectionId}`);
        if (!response.ok) {
          throw new Error('Failed to fetch branches');
        }
        return response.json();
      },
      
      async testConnection() {
        const response = await fetch(`${WORKSPACE_BASE}/settings/test/github-hub`, {
          method: 'POST'
        });
        return response.json();
      }
    },
  };

  // Export globally
  window.API = API;
})();

