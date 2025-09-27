import { qs } from './dom.js';
import { state } from '../core/state.js';
import { bus } from '../core/eventBus.js';
import { getFileIcon } from '../utils/path.js';

export function initTabs(){ updateTabs(); }

export function updateTabs(){
  const container = qs('#tabsContainer'); if (!container) return;
  container.innerHTML = '';
  for (const [filePath, fileData] of state.openFiles){
    const tab = document.createElement('div');
    tab.className = `tab ${filePath === state.activeFile ? 'active' : ''}`;
    const fileName = filePath.split('/').pop();
    const modifiedIndicator = fileData.modified ? ' ●' : '';
    tab.innerHTML = `<span>${getFileIcon(fileName)} ${fileName}${modifiedIndicator}</span><span class="tab-close" title="Close">×</span>`;
    tab.addEventListener('click', (e)=>{
      if (e.target.classList.contains('tab-close')){
        e.stopPropagation(); closeFile(filePath);
      } else {
        switchToFile(filePath);
      }
    });
    container.appendChild(tab);
  }
}

export function switchToFile(filePath){
  state.activeFile = filePath;
  updateTabs();
  bus.emit('file:open', { path: filePath });
}

export function closeFile(filePath){
  const data = state.openFiles.get(filePath);
  if (data?.modified){
    const yes = confirm(`File ${filePath} has unsaved changes. Close anyway?`);
    if (!yes) return;
  }

  const isActive = state.activeFile === filePath;
  const modelToDispose = data?.model;

  // Determine next file if current is active
  let nextToOpen = null;
  if (isActive) {
    const remaining = Array.from(state.openFiles.keys()).filter(p => p !== filePath);
    nextToOpen = remaining.length ? remaining[remaining.length - 1] : null;
  }

  state.openFiles.delete(filePath);

  if (isActive) {
    if (nextToOpen) switchToFile(nextToOpen);
    else { state.activeFile = null; state.editor?.setModel(null); }
  }

  // Dispose model after switching away to avoid disposing the active model
  try { if (modelToDispose && !modelToDispose.isDisposed?.()) modelToDispose.dispose(); } catch {}

  updateTabs();
  bus.emit('ui:fileTree:selection');
}
