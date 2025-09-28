import { qs } from './dom.js';
import { state } from '../core/state.js';
import { bus } from '../core/eventBus.js';
import * as API from '../services/api.js';
import { getFileIcon } from '../utils/path.js';

// Improved file tree rendering and interaction
export function initFileTree(){
  ensureExpandedState();
  const container = qs('#fileTree');
  if (!container) return;

  // Delegate keyboard handling for accessibility
  container.addEventListener('keydown', onKeyDown);

  // Selection highlight update from events
  bus.on('ui:fileTree:selection', highlightSelection);
}

export function renderFileTree(){
  const container = qs('#fileTree');
  if (!container) return;
  container.innerHTML = '';

  // Optional small toolbar for the tree
  const toolbar = document.createElement('div');
  toolbar.className = 'filetree-toolbar';
  toolbar.innerHTML = `<input id="fileTreeFilter" placeholder="Filter files..." style="width:100%;padding:6px;font-size:12px;" />`;
  container.appendChild(toolbar);
  const filterInput = qs('#fileTreeFilter', container);
  let filterTimer = null;
  filterInput.addEventListener('input', (e)=>{
    clearTimeout(filterTimer);
    filterTimer = setTimeout(()=>{
      renderNode(state.fileTree || {}, container, '', (filterInput.value || '').trim().toLowerCase());
      highlightSelection();
    }, 150);
  });

  // Render nodes into a dedicated content area
  const content = document.createElement('div');
  content.className = 'filetree-content';
  content.tabIndex = 0; // make focusable for keyboard navigation
  container.appendChild(content);

  renderNode(state.fileTree || {}, content, '', '');
  highlightSelection();
}

function ensureExpandedState(){
  // state.fileTreeExpanded is a plain object mapping path->true if expanded
  if (!state.fileTreeExpanded || typeof state.fileTreeExpanded !== 'object') state.fileTreeExpanded = {};
}

function renderNode(node, container, path, filter){
  // Clear previous file items (preserve toolbar if present)
  if (!node || typeof node !== 'object'){ return; }

  // If called to re-render under the container that contains toolbar, ensure we don't duplicate
  // We expect container to be the content area created in renderFileTree
  container.innerHTML = '';

  const entries = Object.entries(node).sort((a,b)=> a[0].localeCompare(b[0]));
  if (entries.length === 0){
    const empty = document.createElement('div');
    empty.className = 'filetree-empty muted pad-8';
    empty.textContent = 'No files or folders';
    container.appendChild(empty);
    return;
  }

  for (const [name, item] of entries){
    const fullPath = path ? `${path}/${name}` : name;
    // Basic filter: check name and (if file) content snippet
    if (filter){
      const hay = name.toLowerCase() + ' ' + (item?.content || '');
      if (!hay.includes(filter)) continue;
    }

    if (item && item.type === 'folder'){
      const folderWrap = document.createElement('div');
      folderWrap.className = 'folder-wrap';

      const folderDiv = document.createElement('div');
      folderDiv.className = 'folder-item';
      folderDiv.setAttribute('role','treeitem');
      folderDiv.setAttribute('aria-expanded', !!state.fileTreeExpanded[fullPath]);
      folderDiv.dataset.path = fullPath;
      folderDiv.dataset.type = 'folder';
      folderDiv.tabIndex = 0;

      const toggle = document.createElement('span');
      toggle.className = 'folder-toggle';
      toggle.textContent = state.fileTreeExpanded[fullPath] ? '▾' : '▸';
      toggle.title = state.fileTreeExpanded[fullPath] ? 'Collapse' : 'Expand';
      toggle.style.cursor = 'pointer';
      toggle.addEventListener('click', (e)=>{
        e.stopPropagation();
        toggleFolder(folderDiv, fullPath, item, folderChildren);
      });

      const label = document.createElement('span');
      label.className = 'folder-label';
      label.innerHTML = `<span>📁</span><span class="name">${name}</span>`;

      folderDiv.appendChild(toggle);
      folderDiv.appendChild(label);

      folderDiv.addEventListener('click', (e)=>{
        e.stopPropagation();
        // Toggle on click of label too
        toggleFolder(folderDiv, fullPath, item, folderChildren);
      });

      folderDiv.addEventListener('dblclick', (e)=>{
        e.stopPropagation();
        // Toggle on double click as well
        toggleFolder(folderDiv, fullPath, item, folderChildren);
      });

      folderWrap.appendChild(folderDiv);

      const folderChildren = document.createElement('div');
      folderChildren.className = 'folder-children';
      if (!state.fileTreeExpanded[fullPath]) folderChildren.classList.add('hidden');

      folderWrap.appendChild(folderChildren);
      container.appendChild(folderWrap);

      // If pre-expanded, render children now (or show placeholder for lazy load)
      if (state.fileTreeExpanded[fullPath]){
        ensureFolderChildrenRendered(fullPath, item, folderChildren);
      }
    } else {
      const fileDiv = document.createElement('div');
      fileDiv.className = 'file-item';
      fileDiv.dataset.path = fullPath;
      fileDiv.dataset.type = 'file';
      fileDiv.tabIndex = 0;
      fileDiv.innerHTML = `<span class="icon">${getFileIcon(name)}</span><span class="name">${name}</span>`;
      fileDiv.addEventListener('click', ()=>{
        bus.emit('file:open', { path: fullPath });
      });
      fileDiv.addEventListener('keydown', (ev)=>{
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); bus.emit('file:open', { path: fullPath }); }
      });
      container.appendChild(fileDiv);
    }
  }
}

async function ensureFolderChildrenRendered(fullPath, item, folderChildren){
  // If this folder has no children loaded yet, fetch them (don't depend on _lazy)
  if (!item.children || Object.keys(item.children).length === 0){
    folderChildren.innerHTML = '<div class="pad-8 muted">Loading...</div>';
    try{
      const tree = await API.fetchRemoteTree(fullPath, 1).catch(()=> ({}));
      item.children = tree || {};

      // Mark returned folders as lazy so they can fetch their own children when expanded
      for (const [k, v] of Object.entries(item.children)){
        if (v && v.type === 'folder' && !v.children){
          v._lazy = true;
        }
      }
    } catch (e){
      item.children = item.children || {};
    }
  }

  // Render (whether we fetched or already had children)
  renderNode(item.children || {}, folderChildren, fullPath, '');
  highlightSelection();
}


function toggleFolder(folderDiv, fullPath, item, childrenContainer){
  const expanded = !!state.fileTreeExpanded[fullPath];
  state.fileTreeExpanded[fullPath] = !expanded;
  const toggle = folderDiv.querySelector('.folder-toggle');
  if (toggle) toggle.textContent = !expanded ? '▾' : '▸';
  folderDiv.setAttribute('aria-expanded', String(!expanded));

  if (!expanded){
    // expanding
    childrenContainer.classList.remove('hidden');
    ensureFolderChildrenRendered(fullPath, item, childrenContainer);
  } else {
    // collapsing
    childrenContainer.classList.add('hidden');
    childrenContainer.innerHTML = '';
  }
}

function highlightSelection(){
  const allItems = document.querySelectorAll('#fileTree .file-item, #fileTree .folder-item');
  allItems.forEach(item => {
    item.classList.remove('active','modified');
    const itemPath = item.dataset.path;
    if (!itemPath) return;
    if (state.activeFile === itemPath) item.classList.add('active');

    // mark modified files (use state.openFiles map)
    try{
      if (item.dataset.type === 'file'){
        const fileData = state.openFiles?.get ? state.openFiles.get(itemPath) : (state.openFiles && state.openFiles[itemPath]);
        if (fileData && fileData.modified) item.classList.add('modified');
      }
    }catch(e){}
  });
}

// Keyboard navigation: up/down to move, right to expand, left to collapse, enter to open file
function onKeyDown(ev){
  const container = ev.currentTarget;
  const focusable = Array.from(container.querySelectorAll('.file-item, .folder-item')).filter(n=>!n.classList.contains('hidden'));
  if (!focusable.length) return;
  const idx = focusable.indexOf(document.activeElement);
  switch (ev.key){
    case 'ArrowDown':
      ev.preventDefault();
      if (idx < focusable.length - 1) focusable[idx + 1].focus(); else focusable[0].focus();
      break;
    case 'ArrowUp':
      ev.preventDefault();
      if (idx > 0) focusable[idx - 1].focus(); else focusable[focusable.length - 1].focus();
      break;
    case 'ArrowRight':
      ev.preventDefault();
      if (document.activeElement && document.activeElement.dataset.type === 'folder'){
        const path = document.activeElement.dataset.path;
        const toggle = document.activeElement.querySelector('.folder-toggle');
        if (toggle && toggle.textContent === '▸') toggle.click();
      }
      break;
    case 'ArrowLeft':
      ev.preventDefault();
      if (document.activeElement && document.activeElement.dataset.type === 'folder'){
        const path = document.activeElement.dataset.path;
        const toggle = document.activeElement.querySelector('.folder-toggle');
        if (toggle && toggle.textContent === '▾') toggle.click();
      }
      break;
    case 'Enter':
      ev.preventDefault();
      if (document.activeElement){
        const p = document.activeElement.dataset.path;
        const t = document.activeElement.dataset.type;
        if (t === 'file') bus.emit('file:open', { path: p });
        else { document.activeElement.querySelector('.folder-toggle')?.click(); }
      }
      break;
    default:
      break;
  }
}
