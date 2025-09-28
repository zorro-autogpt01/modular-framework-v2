import * as API from './api.js';
import { showNotification } from '../ui/notifications.js';

export async function connect(){
  const config = {
    host: (document.getElementById('sshHost')?.value || '').trim(),
    port: Number(document.getElementById('sshPort')?.value||22),
    username: (document.getElementById('sshUsername')?.value || '').trim(),
    authMethod: document.getElementById('authMethod')?.value,
    password: document.getElementById('sshPassword')?.value,
    privateKey: document.getElementById('sshPrivateKey')?.value,
    passphrase: document.getElementById('sshPassphrase')?.value,
    remotePath: document.getElementById('remotePath')?.value
  };
  if (!config.host || !config.username){ showNotification('❌ Please fill in required fields', 'error'); return; }
  if (config.authMethod === 'password' && !config.password){ showNotification('❌ Password is required', 'error'); return; }
  if (config.authMethod === 'key' && !(config.privateKey || '').trim()){ showNotification('❌ Provide a private key (upload or paste)', 'error'); return; }
  try{ await API.connectSSH(config); }catch(e){ /* handled in API */ }
}

export async function disconnect(){ await API.disconnectSSH(); }
