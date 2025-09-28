import { state } from '../core/state.js';

export function getLanguageFromPath(filePath){
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map = { js:'javascript', jsx:'javascript', ts:'typescript', tsx:'typescript', html:'html', css:'css', json:'json', md:'markdown', php:'php', py:'python' };
  return map[ext] || 'plaintext';
}

export function getFileFromPath(path){
  const parts = path.split('/').filter(Boolean);
  let current = state.fileTree;
  for (const part of parts){
    if (!current[part]) return null;
    if (current[part].type === 'folder') current = current[part].children; else return current[part];
  }
  return current;
}

export function getFileIcon(fileName){
  const ext = fileName.split('.').pop()?.toLowerCase();
  const icons = { js:'📄', jsx:'⚛️', ts:'📘', tsx:'⚛️', html:'🌐', css:'🎨', json:'📋', md:'📝', php:'🐘', py:'🐍' };
  return icons[ext] || '📄';
}
