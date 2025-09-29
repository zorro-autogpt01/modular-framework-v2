// modular-framework/modules/llm-ide/src/services/git.js
import { showNotification } from '../ui/notifications.js';
import * as API from './api.js';

export async function pull(repoPath) {
  const cmd = repoPath ? `git -C ${JSON.stringify(repoPath)} pull origin main` : 'git pull origin main';
  return API.executeGitCommand(cmd);
}

export async function fetch() {
  return API.executeGitCommand('git fetch');
}

export async function stash() {
  return API.executeGitCommand('git stash');
}

export async function createBranch() {
  const branch = prompt('Enter new branch name:');
  if (branch) {
    return API.executeGitCommand(`git checkout -b ${branch}`);
  }
  return null;
}

export async function quickCommitPush(message) {
  if (!message) {
    showNotification('⚠️ Please enter a commit message', 'warning');
    return;
  }
  showNotification('💫 Executing quick commit & push...', 'info');
  await API.executeGitCommand('git add .');
  await API.executeGitCommand(`git commit -m "${message.replaceAll('"','\\\"')}"`);
  await API.executeGitCommand('git push origin main');
  const el = document.getElementById('commitMessage');
  if (el) el.value = '';
}