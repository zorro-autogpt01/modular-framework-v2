import * as API from './api.js';
import { showNotification } from '../ui/notifications.js';

export async function pull(){ await API.executeGitCommand('git pull origin main'); }
export async function fetch(){ await API.executeGitCommand('git fetch'); }
export async function stash(){ await API.executeGitCommand('git stash'); }
export async function createBranch(){
  const branch = prompt('Enter new branch name:');
  if (branch){ await API.executeGitCommand(`git checkout -b ${branch}`); }
}
export async function quickCommitPush(message){
  if (!message){ showNotification('⚠️ Please enter a commit message', 'warning'); return; }
  showNotification('💫 Executing quick commit & push...', 'info');
  await API.executeGitCommand('git add .');
  await API.executeGitCommand(`git commit -m "${message.replaceAll('"','\\\"')}"`);
  await API.executeGitCommand('git push origin main');
  const el = document.getElementById('commitMessage'); if (el) el.value='';
}
