// src/services/api.js
import { state } from '../core/state.js';
import { bus } from '../core/eventBus.js';
import { showNotification } from '../ui/notifications.js';
import { updateConnectionStatus, updateWorkspaceIndicator } from '../ui/panels.js';
import { addToTerminal } from '../terminal/index.js';

// Dynamic backend URL detection
function getBackendUrls() {
  const loc = window.location;
  const isLocalDev = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1';
  
  let httpUrl, wsUrl;
  
  if (window.__BACKEND_URL) {
    // Use explicitly configured URL
    httpUrl = window.__BACKEND_URL;
  } else if (isLocalDev && loc.port === '3020') {
    // Development mode - IDE on :3020, backend on :3021
    httpUrl = `${loc.protocol}//${loc.hostname}:3021`;
  } else {
    // Production mode - use path-based routing
    httpUrl = `${loc.protocol}//${loc.host}/ide/api`;
  }
  
  // Convert HTTP to WebSocket URL
  wsUrl = httpUrl.replace(/^http/, 'ws') + '/ssh';
  
  return { httpUrl, wsUrl };
}

const { httpUrl: BACKEND_HTTP, wsUrl: BACKEND_WS } = getBackendUrls();

let activeSessionId = null;
let activeSocket = null;

export async function fetchRemoteTree(relOrAbsPath, depth = 10) {
  if (!activeSessionId) throw new Error('No active session');
  const base = (state.remoteRoot || '').replace(/\/$/, '');
  const fullPath = relOrAbsPath?.startsWith('/')
    ? relOrAbsPath
    : (base ? `${base}/${relOrAbsPath || ''}` : (relOrAbsPath || '/'));
  const url = `${BACKEND_HTTP}/ssh/list?sessionId=${encodeURIComponent(activeSessionId)}&path=${encodeURIComponent(fullPath)}&depth=${depth}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'List failed');
  return data.tree || {};
}

export async function readRemoteFile(relPath) {
  if (!activeSessionId) throw new Error('No active session');
  
  const base = (state.remoteRoot || '').replace(/\/$/, '');
  const fullPath = base + (relPath.startsWith('/') ? relPath : '/' + relPath);
  
  const url = new URL('ssh/read', BACKEND_HTTP);
  url.searchParams.append('sessionId', activeSessionId);
  url.searchParams.append('path', fullPath);
  
  try {
    const res = await fetch(url.toString());
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Read failed');
    return data.content ?? '';
  } catch (e) {
    console.error('readRemoteFile error:', e);
    throw e;
  }
}

export async function writeRemoteFile(relPath, content) {
  if (!activeSessionId) throw new Error('No active session');
  
  const base = (state.remoteRoot || '').replace(/\/$/, '');
  const fullPath = base + (relPath.startsWith('/') ? relPath : '/' + relPath);
  
  try {
    const res = await fetch(`${BACKEND_HTTP}/ssh/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        sessionId: activeSessionId, 
        path: fullPath, 
        content: content || ''
      })
    });
    
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Write failed');
    return true;
  } catch (e) {
    console.error('writeRemoteFile error:', e);
    throw e;
  }
}

export async function makeRemoteDir(relPath, { recursive = true } = {}) {
  if (!activeSessionId) throw new Error('No active session');
  
  const base = (state.remoteRoot || '').replace(/\/$/, '');
  const fullPath = base + (relPath.startsWith('/') ? relPath : '/' + relPath);
  
  try {
    const res = await fetch(`${BACKEND_HTTP}/ssh/mkdir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        sessionId: activeSessionId, 
        path: fullPath, 
        recursive: Boolean(recursive)
      })
    });
    
    if (!res.ok) {
      const text = await res.text();
      throw new Error(text || `HTTP ${res.status}`);
    }
    
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Mkdir failed');
    return true;
  } catch (e) {
    console.error('makeRemoteDir error:', e);
    throw e;
  }
}

export function getActiveSocket() { return activeSocket; }
export function getActiveSession() { return activeSessionId; }

export async function connectSSH(config) {
  showNotification('🔗 Connecting to SSH...', 'info');
  
  // Validate and clean config
  const cleanConfig = {
    host: String(config.host || '').trim(),
    port: parseInt(config.port, 10) || 22,
    username: String(config.username || '').trim(),
    authMethod: String(config.authMethod || 'password'),
    remotePath: String(config.remotePath || '/').trim()
  };
  
  // Add authentication fields based on method
  if (cleanConfig.authMethod === 'password') {
    cleanConfig.password = String(config.password || '');
  } else if (cleanConfig.authMethod === 'key') {
    cleanConfig.privateKey = String(config.privateKey || '');
    if (config.passphrase) {
      cleanConfig.passphrase = String(config.passphrase);
    }
  }
  
  console.log('[SSH] Connecting to', cleanConfig.host, 'as', cleanConfig.username);
  
  try {
    const res = await fetch(`${BACKEND_HTTP}/ssh/connect`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(cleanConfig)
    });
    
    let data;
    const contentType = res.headers.get('content-type');
    
    if (contentType && contentType.includes('application/json')) {
      data = await res.json();
    } else {
      // If not JSON, try to read as text and parse
      const text = await res.text();
      try {
        data = JSON.parse(text);
      } catch {
        // If parsing fails, create error response
        data = { 
          ok: false, 
          error: text || `HTTP ${res.status}` 
        };
      }
    }
    
    if (!res.ok || !data.ok) {
      throw new Error(data.error || `Connection failed (HTTP ${res.status})`);
    }
    
    activeSessionId = data.sessionId;
    
    // Open WebSocket for interactive shell
    const wsUrl = `${BACKEND_WS}?sessionId=${encodeURIComponent(activeSessionId)}`;
    console.log('[SSH] Opening WebSocket to', wsUrl);
    
    activeSocket = new WebSocket(wsUrl);
    activeSocket.binaryType = 'arraybuffer';
    
    return new Promise((resolve, reject) => {
      let connectionTimeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
        activeSocket?.close();
      }, 10000);
      
      activeSocket.onopen = async () => {
        clearTimeout(connectionTimeout);
        console.log('[SSH] WebSocket connected');
        
        state.isConnected = true;
        state.currentWorkspace = 'remote';
        state.remoteRoot = cleanConfig.remotePath || '/';
        
        updateConnectionStatus(true, cleanConfig.host);
        updateWorkspaceIndicator('Remote: ' + cleanConfig.host);
        
        const connectBtn = document.getElementById('connectBtn');
        const disconnectBtn = document.getElementById('disconnectBtn');
        if (connectBtn) connectBtn.classList.add('hidden');
        if (disconnectBtn) disconnectBtn.classList.remove('hidden');
        
        const termHost = document.getElementById('terminalHost');
        if (termHost) termHost.textContent = cleanConfig.host;
        
        addToTerminal(`Connected to ${cleanConfig.host}\n`);
        showNotification(`✅ Connected to ${cleanConfig.host}`, 'success');
        
        bus.emit('workspace:changed', { connected: true, host: cleanConfig.host });
        
        // Load remote file tree
        try {
          const tree = await fetchRemoteTree(state.remoteRoot, 2);
          bus.emit('fileTree:replace', { tree });
        } catch (err) {
          console.error('[SSH] Failed to load file tree:', err);
          showNotification('⚠️ Failed to load remote file tree', 'warning');
          bus.emit('fileTree:replace', { tree: {} });
        }
        
        resolve({ success: true, host: cleanConfig.host });
      };
      
      activeSocket.onmessage = (ev) => {
        try {
          const text = typeof ev.data === 'string' 
            ? ev.data 
            : new TextDecoder().decode(new Uint8Array(ev.data));
          addToTerminal(text);
        } catch (e) {
          console.error('[SSH] Failed to decode message:', e);
        }
      };
      
      activeSocket.onerror = (ev) => {
        clearTimeout(connectionTimeout);
        console.error('[SSH] WebSocket error:', ev);
        addToTerminal('[WS] Connection error\n');
        reject(new Error('WebSocket connection error'));
      };
      
      activeSocket.onclose = (ev) => {
        clearTimeout(connectionTimeout);
        console.log('[SSH] WebSocket closed:', ev.code, ev.reason);
        addToTerminal(`[WS] Connection closed (${ev.code})\n`);
        
        // Clean up state if still connected
        if (state.isConnected) {
          state.isConnected = false;
          state.currentWorkspace = 'local';
          updateConnectionStatus(false);
          updateWorkspaceIndicator('Local');
        }
      };
    });
    
  } catch (e) {
    console.error('[SSH] Connection error:', e);
    showNotification('❌ Connection failed: ' + (e?.message || e), 'error');
    
    // Clean up on error
    activeSessionId = null;
    activeSocket?.close();
    activeSocket = null;
    
    throw e;
  }
}

export async function disconnectSSH() {
  console.log('[SSH] Disconnecting...');
  
  try {
    if (activeSessionId) {
      await fetch(`${BACKEND_HTTP}/ssh/disconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId })
      });
    }
  } catch (e) {
    console.error('[SSH] Disconnect error:', e);
  }
  
  try {
    activeSocket?.close();
  } catch {}
  
  activeSocket = null;
  activeSessionId = null;
  
  state.isConnected = false;
  state.currentWorkspace = 'local';
  state.remoteRoot = null;
  
  updateConnectionStatus(false);
  updateWorkspaceIndicator('Local');
  bus.emit('fileTree:replace', { tree: {} });
  
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  if (connectBtn) connectBtn.classList.remove('hidden');
  if (disconnectBtn) disconnectBtn.classList.add('hidden');
  
  const termHost = document.getElementById('terminalHost');
  if (termHost) termHost.textContent = 'localhost';
  
  addToTerminal('Disconnected from remote server\n');
  showNotification('🔌 Disconnected from SSH', 'info');
  
  bus.emit('workspace:changed', { connected: false, host: 'localhost' });
  
  return { success: true };
}

export async function executeGitCommand(command) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ type: 'data', data: command + '\n' }));
    return { output: '', success: true };
  }
  
  // Fallback to simulated output if not connected
  return new Promise(resolve => {
    setTimeout(() => {
      addToTerminal(`$ ${command}\n`);
      const output = simulateGitOutput(command);
      addToTerminal(output + '\n');
      resolve({ output, success: true });
    }, 400);
  });
}

export async function executeRemoteCommand(command) {
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ type: 'data', data: command + '\n' }));
    return { output: '', exitCode: 0 };
  }
  
  // Simulated output for local mode
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({ output: simulateCommandOutput(command), exitCode: 0 });
    }, 300);
  });
}

// GitHub action execution (unchanged)
export function executeGitHubAction() {
  const token = document.getElementById('githubToken')?.value?.trim();
  const repoUrlRaw = document.getElementById('repoUrl')?.value?.trim();
  const action = document.getElementById('gitAction')?.value || 'clone';
  
  if (!repoUrlRaw) {
    showNotification('⚠️ Repository URL is required', 'warning');
    return;
  }
  
  const repoUrl = repoUrlRaw;
  const isSSH = /^git@/.test(repoUrl);
  const isHTTPS = /^https:\/\//.test(repoUrl);
  const needsToken = isHTTPS && !isSSH;
  
  const urlWithToken = (needsToken && token) ? injectToken(repoUrl, token) : repoUrl;
  const sanitized = needsToken ? injectToken(repoUrl, '***') : repoUrl;
  
  const buildCmd = () => {
    switch (action) {
      case 'clone': return `git clone ${urlWithToken}`;
      case 'init': return `git init && git remote add origin ${urlWithToken}`;
      case 'connect': return `git remote set-url origin ${urlWithToken}`;
      default: return `git clone ${urlWithToken}`;
    }
  };
  
  const cmd = buildCmd();
  const displayCmd = cmd.replace(urlWithToken, sanitized);
  
  addToTerminal(`$ ${displayCmd}\n`);
  
  if (needsToken && !token) {
    showNotification('⚠️ HTTPS URL detected. Provide a GitHub Token or use SSH URL', 'warning');
  }
  
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN) {
    activeSocket.send(JSON.stringify({ type: 'data', data: cmd + '\n' }));
    showNotification('🐙 Running Git command in remote terminal', 'info');
    document.querySelector('#githubModal')?.classList.add('hidden');
  } else {
    showNotification('ℹ️ Not connected to SSH. Run the command locally or connect first.', 'info');
  }
}

function injectToken(repoUrl, token) {
  try {
    const m = repoUrl.match(/^https:\/\/([^\/]+)\/(.+)$/);
    if (!m) return repoUrl;
    return `https://x-access-token:${encodeURIComponent(token)}@${m[1]}/${m[2]}`;
  } catch {
    return repoUrl;
  }
}

function simulateCommandOutput(cmd) {
  const outputs = {
    'ls': 'total 8\ndrwxr-xr-x  3 user user 4096 projects\n-rw-r--r--  1 user user  220 .bashrc',
    'pwd': state.currentWorkspace === 'remote' ? '/home/developer' : '/Users/developer',
    'whoami': 'developer',
    'node --version': 'v18.17.1',
    'npm --version': '9.8.1'
  };
  return outputs[cmd] || `Command executed: ${cmd}`;
}

function simulateGitOutput(command) {
  const outputs = {
    'git status': 'On branch main\nYour branch is up to date with "origin/main".\nNothing to commit',
    'git pull origin main': 'Already up to date.',
    'git push origin main': 'Everything up-to-date',
    'git add .': 'Files staged for commit',
    'git fetch': 'Already up to date.'
  };
  
  for (const [key, val] of Object.entries(outputs)) {
    if (command.startsWith(key)) return val;
  }
  return 'Git command executed successfully';
}