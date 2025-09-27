import { qs } from './dom.js';
import { state } from '../core/state.js';
import { bus } from '../core/eventBus.js';
import { getFileIcon } from '../utils/path.js';
import * as API from '../services/api.js';

export function initFileTree(){
  renderFileTree();
  bus.on('ui:fileTree:selection', highlightSelection);
}

export function renderFileTree(){
  const container = qs('#fileTree');
  if (!container) return;
  container.innerHTML = '';
  renderNode(state.fileTree, container, '');
}

function renderNode(node, container, path){
  Object.entries(node).forEach(([name, item])=>{
    const fullPath = path ? `${path}/${name}` : name;
    if (item.type === 'folder'){
      const folderDiv = document.createElement('div');
      folderDiv.className = 'folder-item';
      folderDiv.innerHTML = `<span>📁</span><span>${name}</span>`;
      const childrenDiv = document.createElement('div');
      childrenDiv.className = 'folder-children hidden';
      // mark as not yet loaded for lazy load
      childrenDiv.dataset.loaded = item.children && Object.keys(item.children).length ? 'true' : '';

      folderDiv.addEventListener('click', async (e)=>{
        e.stopPropagation();
        const willExpand = childrenDiv.classList.contains('hidden');
        if (willExpand && !childrenDiv.dataset.loaded) {
          // lazy load
          if (childrenDiv.dataset.loading === 'true') return;
          childrenDiv.dataset.loading = 'true';
          childrenDiv.innerHTML = `<div class="pad-8 muted">Loading…</div>`;
          try {
            const sub = await API.fetchRemoteTree(fullPath, 1);
            // update in-memory tree
            try { item.children = sub; } catch {}
            // render fresh
            childrenDiv.innerHTML = '';
            renderNode(sub, childrenDiv, fullPath);
            childrenDiv.dataset.loaded = 'true';
          } catch (err) {
            childrenDiv.innerHTML = `<div class="pad-8 err">Failed to load: ${err?.message || err}</div>`;
          } finally {
            childrenDiv.dataset.loading = '';
          }
        }
        childrenDiv.classList.toggle('hidden');
      });

      container.appendChild(folderDiv);
      container.appendChild(childrenDiv);
      
    } else {
      const fileDiv = document.createElement('div');
      fileDiv.className = 'file-item';
      fileDiv.innerHTML = `<span>${getFileIcon(name)}</span><span>${name}</span>`;
      fileDiv.addEventListener('click', ()=> bus.emit('file:open', { path: fullPath }));
      container.appendChild(fileDiv);
    }
  });
  highlightSelection();
}

function highlightSelection(){
  const items = document.querySelectorAll('.file-item');
  items.forEach(item=>{
    item.classList.remove('active','modified');
    const label = item.textContent.trim();
    if (state.activeFile && state.activeFile.endsWith(label)) item.classList.add('active');
    for (const [filePath, fileData] of state.openFiles){
      if (filePath.endsWith(label) && fileData.modified){ item.classList.add('modified'); }
    }
  });
}
