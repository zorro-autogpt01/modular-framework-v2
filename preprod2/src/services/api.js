import { state } from '../core/state.js';
import { bus } from '../core/eventBus.js';
import { showNotification } from '../ui/notifications.js';
import { updateConnectionStatus, updateWorkspaceIndicator } from '../ui/panels.js';
import { remoteTree } from '../data/sampleFileTree.js';
import { addToTerminal } from '../terminal/index.js';

const BACKEND_HTTP = window.__BACKEND_URL || 'http://localhost:3021';
const BACKEND_WS = (BACKEND_HTTP.startsWith('https') ? 'wss' : 'ws') + '://' + BACKEND_HTTP.replace(/^https?:\/\//, '') + '/ssh';

let activeSessionId = null;
let activeSocket = null;

export function getActiveSocket(){ return activeSocket; }
export function getActiveSession(){ return activeSessionId; }

export async function connectSSH(config){
  showNotification('🔗 Connecting to SSH...', 'info');
  try {
    const res = await fetch(`${BACKEND_HTTP}/ssh/connect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // Never log this body; it contains secrets
      body: JSON.stringify(config)
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Connect failed');

    activeSessionId = data.sessionId;
    // Open WS for interactive shell
    activeSocket = new WebSocket(`${BACKEND_WS}?sessionId=${encodeURIComponent(activeSessionId)}`);

    activeSocket.binaryType = 'arraybuffer';
    activeSocket.onopen = () => {
      state.isConnected = true; state.currentWorkspace = 'remote';
      updateConnectionStatus(true, config.host);
      updateWorkspaceIndicator('Remote: ' + config.host);
      bus.emit('fileTree:replace', { tree: remoteTree });
      document.getElementById('connectBtn')?.classList.add('hidden');
      document.getElementById('disconnectBtn')?.classList.remove('hidden');
      document.getElementById('terminalHost').textContent = config.host;
      addToTerminal(`Connected to ${config.host}`);
      showNotification(`✅ Connected to ${config.host}`, 'success');
      bus.emit('workspace:changed', { connected: true, host: config.host });
    };

    activeSocket.onmessage = (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(new Uint8Array(ev.data));
      addToTerminal(text);
    };

    activeSocket.onclose = () => {
      // Socket closed; leave UI cleanup to disconnect or remote exit
    };

    return { success: true, host: config.host };
  } catch (e) {
    showNotification('❌ Connection failed: ' + (e?.message || e), 'error');
    throw e;
  }
}

export async function disconnectSSH(){
  try {
    if (activeSessionId) {
      await fetch(`${BACKEND_HTTP}/ssh/disconnect`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId })
      });
    }
  } catch {}
  try { activeSocket?.close(); } catch {}
  activeSocket = null; activeSessionId = null;

  state.isConnected = false; state.currentWorkspace = 'local';
  updateConnectionStatus(false);
  updateWorkspaceIndicator('Local');
  bus.emit('fileTree:replace', { tree: {} });
  document.getElementById('connectBtn')?.classList.remove('hidden');
  document.getElementById('disconnectBtn')?.classList.add('hidden');
  document.getElementById('terminalHost').textContent = 'localhost';
  addToTerminal('Disconnected from remote server');
  showNotification('🔌 Disconnected from SSH', 'info');
  bus.emit('workspace:changed', { connected: false, host: 'localhost' });
  return { success: true };
}

export async function executeGitCommand(command){
  // unchanged (simulated)
  return new Promise(resolve=>{
    setTimeout(()=>{
      addToTerminal(`$ ${command}`);
      const output = simulateGitOutput(command);
      addToTerminal(output);
      resolve({ output, success: true });
    }, 400);
  });
}

export async function executeRemoteCommand(command){
  // If we have an SSH WS, write to shell; otherwise simulated
  if (activeSocket && activeSocket.readyState === WebSocket.OPEN){
    activeSocket.send(JSON.stringify({ type:'data', data: command + '\n' }));
    return { output: '', exitCode: 0 };
  }
  return new Promise(resolve=>{
    setTimeout(()=>{ resolve({ output: simulateCommandOutput(command), exitCode: 0 }); }, 300);
  });
}

export function executeGitHubAction(){
  const token = document.getElementById('githubToken')?.value;
  const repoUrl = document.getElementById('repoUrl')?.value;
  if (!token || !repoUrl){ showNotification('⚠️ Please fill in all fields', 'warning'); return; }
  showNotification('🐙 Executing GitHub action...', 'info');
  setTimeout(()=>{ showNotification('✅ GitHub integration successful', 'success'); document.querySelector('#githubModal')?.classList.add('hidden'); }, 800);
}

function simulateCommandOutput(cmd){
  const outputs = {
    'ls': 'total 8\ndrwxr-xr-x  3 user user 4096 projects\n-rw-r--r--  1 user user  220 .bashrc',
    'pwd': state.currentWorkspace === 'remote' ? '/home/developer' : '/Users/developer',
    'whoami': 'developer',
    'node --version': 'v18.17.1',
    'npm --version': '9.8.1'
  };
  return outputs[cmd] || `Command executed: ${cmd}`;
}

function simulateGitOutput(command){
  const outputs = {
    'git status': 'On branch main\nYour branch is up to date with "origin/main".\nNothing to commit, working tree clean',
    'git pull origin main': 'Already up to date.',
    'git push origin main': 'Everything up-to-date',
    'git add .': 'Files staged for commit',
    'git fetch': 'Already up to date.'
  };
  for (const [key,val] of Object.entries(outputs)) if (command.startsWith(key)) return val;
  return 'Git command executed successfully';
}
