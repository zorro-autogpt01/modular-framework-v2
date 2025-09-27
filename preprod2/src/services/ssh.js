import * as API from './api.js';
import { showNotification } from '../ui/notifications.js';

export async function connect(){
  const config = {
    host: document.getElementById('sshHost')?.value,
    port: Number(document.getElementById('sshPort')?.value||22),
    username: document.getElementById('sshUsername')?.value,
    authMethod: document.getElementById('authMethod')?.value,
    password: document.getElementById('sshPassword')?.value,
    remotePath: document.getElementById('remotePath')?.value
  };
  if (!config.host || !config.username){ showNotification('❌ Please fill in required fields', 'error'); return; }
  try{ await API.connectSSH(config); }catch(e){ showNotification('❌ Connection failed: ' + (e?.message||e), 'error'); }
}

export async function disconnect(){ await API.disconnectSSH(); }
