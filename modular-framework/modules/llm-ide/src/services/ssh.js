// src/services/ssh.js
import * as API from './api.js';
import { showNotification } from '../ui/notifications.js';
import { qs } from '../ui/dom.js';
import { bus } from '../core/eventBus.js';

// Storage key for SSH connections
const SSH_STORAGE_KEY = 'ide_ssh_connections';

// Simple encryption for passwords/keys (use a better solution in production)
function simpleEncrypt(text) {
  // This is a placeholder - use proper encryption in production
  return btoa(encodeURIComponent(text));
}

function simpleDecrypt(encrypted) {
  try {
    return decodeURIComponent(atob(encrypted));
  } catch {
    return '';
  }
}

// Load saved SSH connections from localStorage
export function loadSavedConnections() {
  try {
    const stored = localStorage.getItem(SSH_STORAGE_KEY);
    if (!stored) return [];
    
    const connections = JSON.parse(stored);
    // Decrypt sensitive fields
    return connections.map(conn => ({
      ...conn,
      password: conn.password ? simpleDecrypt(conn.password) : '',
      privateKey: conn.privateKey ? simpleDecrypt(conn.privateKey) : '',
      passphrase: conn.passphrase ? simpleDecrypt(conn.passphrase) : ''
    }));
  } catch (e) {
    console.error('Failed to load SSH connections:', e);
    return [];
  }
}

// Save SSH connections to localStorage
export function saveConnections(connections) {
  try {
    // Encrypt sensitive fields before storing
    const toStore = connections.map(conn => ({
      ...conn,
      password: conn.password ? simpleEncrypt(conn.password) : '',
      privateKey: conn.privateKey ? simpleEncrypt(conn.privateKey) : '',
      passphrase: conn.passphrase ? simpleEncrypt(conn.passphrase) : ''
    }));
    
    localStorage.setItem(SSH_STORAGE_KEY, JSON.stringify(toStore));
    return true;
  } catch (e) {
    console.error('Failed to save SSH connections:', e);
    return false;
  }
}

// Render saved connections in the UI
export function renderSavedConnections() {
  const container = qs('#sshConnections');
  if (!container) return;
  
  const connections = loadSavedConnections();
  container.innerHTML = '';
  
  if (connections.length === 0) {
    container.innerHTML = '<div class="placeholder">No saved connections</div>';
    return;
  }
  
  connections.forEach((conn, index) => {
    const item = document.createElement('div');
    item.className = 'ssh-connection-item';
    item.innerHTML = `
      <div class="row">
        <div class="status saved"></div>
        <span>${conn.name || conn.host}</span>
        <span class="muted">${conn.username}@${conn.host}:${conn.port}</span>
      </div>
      <div class="row gap-4">
        <button class="btn small" data-action="ssh:connect-saved" data-index="${index}">Connect</button>
        <button class="btn small danger" data-action="ssh:delete-saved" data-index="${index}">×</button>
      </div>
    `;
    container.appendChild(item);
  });
}

// Test SSH connection
export async function testConnection() {
  const config = gatherConnectionConfig();
  if (!validateConfig(config)) return;
  
  showNotification('🔗 Testing SSH connection...', 'info');
  
  try {
    // Create a temporary connection just to test
    const result = await API.connectSSH(config);
    
    // If successful, immediately disconnect
    await API.disconnectSSH();
    
    showNotification('✅ Connection test successful!', 'success');
    return true;
  } catch (e) {
    showNotification(`❌ Connection test failed: ${e?.message || e}`, 'error');
    return false;
  }
}

// Save and connect to SSH
export async function saveAndConnect() {
  const config = gatherConnectionConfig();
  if (!validateConfig(config)) return;
  
  // Add name if provided
  const name = qs('#sshConnectionName')?.value?.trim();
  if (name) config.name = name;
  
  // Check if we should save credentials
  const saveCredentials = qs('#saveCredentials')?.checked;
  
  if (saveCredentials) {
    // Save to localStorage
    const connections = loadSavedConnections();
    
    // Check if a connection with this name already exists
    const existingIndex = connections.findIndex(c => 
      (c.name === config.name) || 
      (c.host === config.host && c.username === config.username && c.port === config.port)
    );
    
    if (existingIndex >= 0) {
      // Update existing
      connections[existingIndex] = config;
    } else {
      // Add new
      connections.push(config);
    }
    
    if (saveConnections(connections)) {
      showNotification('💾 Connection saved', 'success');
      renderSavedConnections();
    }
  }
  
  // Connect
  try {
    await API.connectSSH(config);
    
    // Close the modal
    qs('#sshModal')?.classList.add('hidden');
    
    // Update SSH section to show connected state
    updateConnectionUI(config);
  } catch(e) {
    // Error handled in API
  }
}

// Connect using saved connection
export async function connectSaved(index) {
  const connections = loadSavedConnections();
  const config = connections[index];
  if (!config) {
    showNotification('❌ Connection not found', 'error');
    return;
  }
  
  try {
    await API.connectSSH(config);
    updateConnectionUI(config);
  } catch(e) {
    // Error handled in API
  }
}

// Delete saved connection
export function deleteSaved(index) {
  const connections = loadSavedConnections();
  const conn = connections[index];
  if (!conn) return;
  
  if (confirm(`Delete connection "${conn.name || conn.host}"?`)) {
    connections.splice(index, 1);
    saveConnections(connections);
    renderSavedConnections();
    showNotification('🗑️ Connection deleted', 'info');
  }
}

// Connect to SSH (called from button)
export async function connect() {
  const config = gatherConnectionConfig();
  if (!validateConfig(config)) return;
  
  try {
    await API.connectSSH(config);
    updateConnectionUI(config);
  } catch(e) {
    // Error handled in API
  }
}

// Disconnect from SSH
export async function disconnect() {
  await API.disconnectSSH();
  updateConnectionUI(null);
}

// Gather configuration from form fields
function gatherConnectionConfig() {
  const config = {
    host: (qs('#sshHost')?.value || '').trim(),
    port: parseInt(qs('#sshPort')?.value || '22', 10),
    username: (qs('#sshUsername')?.value || '').trim(),
    authMethod: qs('#authMethod')?.value || 'password',
    remotePath: qs('#remotePath')?.value || '/home/developer'
  };
  
  // Handle authentication fields
  if (config.authMethod === 'password') {
    config.password = qs('#sshPassword')?.value || '';
  } else if (config.authMethod === 'key') {
    config.privateKey = qs('#sshPrivateKey')?.value || '';
    config.passphrase = qs('#sshPassphrase')?.value || '';
  }
  
  return config;
}

// Validate configuration
function validateConfig(config) {
  if (!config.host) {
    showNotification('❌ Please enter a host', 'error');
    return false;
  }
  
  if (!config.username) {
    showNotification('❌ Please enter a username', 'error');
    return false;
  }
  
  if (config.authMethod === 'password' && !config.password) {
    showNotification('❌ Please enter a password', 'error');
    return false;
  }
  
  if (config.authMethod === 'key' && !config.privateKey?.trim()) {
    showNotification('❌ Please provide a private key', 'error');
    return false;
  }
  
  // Ensure port is valid
  if (isNaN(config.port) || config.port < 1 || config.port > 65535) {
    config.port = 22;
  }
  
  return true;
}

// Update connection UI state
function updateConnectionUI(config) {
  const statusEl = qs('#connectionStatus');
  const textEl = qs('#connectionText');
  
  if (config) {
    // Connected
    if (statusEl) statusEl.classList.add('connected');
    if (textEl) textEl.textContent = `Connected to ${config.host}`;
    
    // Update all connection items to show which one is active
    const connections = loadSavedConnections();
    const container = qs('#sshConnections');
    if (container) {
      container.querySelectorAll('.ssh-connection-item').forEach((item, idx) => {
        const conn = connections[idx];
        const statusDot = item.querySelector('.status');
        if (conn && conn.host === config.host && conn.username === config.username) {
          statusDot?.classList.remove('saved');
          statusDot?.classList.add('connected');
        } else {
          statusDot?.classList.remove('connected');
          statusDot?.classList.add('saved');
        }
      });
    }
  } else {
    // Disconnected
    if (statusEl) statusEl.classList.remove('connected');
    if (textEl) textEl.textContent = 'Disconnected';
    
    // Reset all connection items
    const container = qs('#sshConnections');
    if (container) {
      container.querySelectorAll('.status').forEach(dot => {
        dot.classList.remove('connected');
        dot.classList.add('saved');
      });
    }
  }
}

// Initialize SSH connections on load
export function initSSH() {
  renderSavedConnections();
  
  // Handle auth method toggle
  const authSel = qs('#authMethod');
  const updateAuthGroups = (val) => {
    const isPassword = val === 'password';
    const pw = qs('#passwordGroup');
    const pk = qs('#privateKeyGroup');
    const pp = qs('#passphraseGroup');
    if (pw) pw.classList.toggle('hidden', !isPassword);
    if (pk) pk.classList.toggle('hidden', isPassword);
    if (pp) pp.classList.toggle('hidden', isPassword);
  };
  
  authSel?.addEventListener('change', (e) => updateAuthGroups(e.target.value));
  if (authSel) updateAuthGroups(authSel.value);
  
  // Handle SSH key file upload
  const keyInput = qs('#sshKeyFile');
  const keyBtn = qs('#sshKeyFileLoadBtn');
  const keyText = qs('#sshPrivateKey');
  
  const loadKeyToTextarea = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      if (keyText) keyText.value = String(e.target.result || '');
      showNotification(`🔐 Loaded key: ${file.name}`, 'success');
    };
    reader.readAsText(file);
  };
  
  keyInput?.addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) loadKeyToTextarea(f);
  });
  
  keyBtn?.addEventListener('click', () => {
    if (keyInput?.files?.length) {
      loadKeyToTextarea(keyInput.files[0]);
    } else {
      keyInput?.click();
    }
  });
}