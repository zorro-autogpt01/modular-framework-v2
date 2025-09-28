import { qs } from '../ui/dom.js';
import { state } from '../core/state.js';
import * as API from '../services/api.js';

export function initTerminal(){
  const input = qs('#terminalInput');
  input?.addEventListener('keydown', (e)=>{
    if (e.ctrlKey && e.key.toLowerCase() === 'c'){
      const ws = API.getActiveSocket?.();
      if (ws && ws.readyState === WebSocket.OPEN){ ws.send(JSON.stringify({ type:'data', data: '\u0003' })); }
      e.preventDefault();
    }
  });

  qs('#terminalInput')?.addEventListener('keypress', (e)=>{
    if (e.key === 'Enter'){
      executeTerminalCommand(e.target.value);
      e.target.value='';
    }
  });
}

function bindTerminalInput(){
  const input = qs('#terminalInput');
  if (!input || input.__bound) return;
  input.addEventListener('keypress', (e)=>{
    if (e.key === 'Enter'){
      executeTerminalCommand(e.target.value);
      e.target.value='';
    }
  });
  input.__bound = true;
}

export function toggleTerminalPanel(){
  const panel = qs('#bottomPanel');
  panel?.classList.toggle('hidden');
}

export function executeTerminalCommand(command){
  if (!command || !command.trim()) return;
  addToTerminal(`$ ${command}`);
  if (command === 'help'){ addToTerminal('Available: ls, pwd, whoami, node --version, npm --version, git, docker, npm, help, clear'); return; }
  if (command === 'clear'){
    const t = qs('#terminal');
    const currentHost = qs('#terminalHost')?.textContent || 'localhost';
    t.innerHTML = `<div>🚀 Advanced Web IDE Pro - Terminal</div><div>Connected to: <span id="terminalHost">${currentHost}</span></div><div>Type 'help' for available commands</div><div class="terminal-input"><span class="terminal-prompt">$</span><input type="text" class="terminal-command" id="terminalInput" placeholder="Enter command..." /></div>`;
    // Re-bind input after DOM replacement
    bindTerminalInput();
    return;
  }
  if (command.startsWith('git ')) { API.executeGitCommand(command); return; }
  API.executeRemoteCommand(command).then(result=> addToTerminal(result.output));
}

export function addToTerminal(text){
  const terminal = qs('#terminal');
  const div = document.createElement('div'); div.textContent = text;
  terminal.appendChild(div); terminal.scrollTop = terminal.scrollHeight;
}

export function addToOutput(text){
  const output = qs('#outputContent');
  const div = document.createElement('div'); div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  output.appendChild(div); output.scrollTop = output.scrollHeight;
}

export function addToDockerLogs(text){
  const logs = qs('#dockerLogs');
  const div = document.createElement('div'); div.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logs.appendChild(div); logs.scrollTop = logs.scrollHeight;
}
