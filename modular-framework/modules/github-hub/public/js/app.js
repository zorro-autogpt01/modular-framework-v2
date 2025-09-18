const $ = (id)=>document.getElementById(id);
const isSide = new URLSearchParams(location.search).get('embed') === 'side';

// Figure out the module base (works standalone and when proxied)
// Examples:
//  - http://host:3005/ui/           -> API = /api
//  - http://host:3005/              -> API = /api
//  - http://framework/api/github-hub/ui/ -> API = /api/github-hub/api
//  - http://framework/api/github-hub/    -> API = /api/github-hub/api
const API = (() => {
  const p = location.pathname;

  // If we’re under /.../ui/..., strip the /ui part
  const idx = p.indexOf('/ui/');
  if (idx !== -1) return p.slice(0, idx) + '/api';

  // If we’re already under a proxied prefix like /api/github-hub/...
  const m = p.match(/^(.*?\/api\/github-hub)(?:\/|$)/);
  if (m) return `${m[1]}/api`;

  // Standalone (served from module root)
  return '/api';
})();

async function api(path, init){
  const r = await fetch(`${API}${path}`, init);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export async function loadConfig(){
  try{
    const c = await api("/config");
    $('repoUrl').value = c.repo_url || '';
    $('baseUrl').value = c.base_url || 'https://api.github.com';
    await loadBranches();
  }catch(e){ console.warn(e); }
}

export async function saveConfig(){
  const body = {
    repo_url: $('repoUrl').value.trim(),
    default_branch: $('branchSelect').value || 'main',
  };
  const tok = $('token').value.trim(); if (tok) body.token = tok;
  const base = $('baseUrl').value.trim(); if (base) body.base_url = base;

  await api("/config", {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify(body)
  });
  $('token').value = '';
  await loadBranches();
  await loadTree();
}

export async function loadBranches(){
  const sel = $('branchSelect');
  sel.innerHTML = '';
  try{
    const b = await api("/branches");
    (b.branches||[]).forEach(name=>{
      const o = document.createElement('option'); o.value=o.textContent = name; sel.appendChild(o);
    });
  }catch(e){
    // fallback options so first run isn't empty
    ['main','master'].forEach(n=>{
      const o = document.createElement('option'); o.value=o.textContent = n; sel.appendChild(o);
    });
  }
}

let currentFile = null;
let currentSha  = null;

export async function openFile(path){
  const branch = $('branchSelect').value || 'main';
  const data = await api(`/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`);
  currentFile = path;
  currentSha  = data.sha;
  $('fileMeta').textContent = `${path} @ ${branch} (sha ${data.sha?.slice(0,7)})`;
  $('fileView').textContent = data.decoded_content || '';
}

export async function saveFile(){
  if (!currentFile) return alert('No file open');
  const branch = $('branchSelect').value || 'main';
  const message = $('commitMsg').value.trim() || `Update ${currentFile}`;
  const content = $('fileView').textContent;
  const payload = { path: currentFile, message, content, branch, sha: currentSha };
  const res = await api('/file', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  alert(`Committed ${currentFile}\n${res.commit?.sha || res.content?.sha || ''}`);
  await loadTree();
  await openFile(currentFile);
}

// -------- Tree (collapsed by default, folder-select selects all descendants) ----------
export async function loadTree(){
  const treeEl = $('tree');
  treeEl.innerHTML = '<div class="muted">Loading…</div>';

  try{
    const branch = $('branchSelect').value || 'main';
    const t = await api(`/tree?branch=${encodeURIComponent(branch)}&recursive=true`);
    const items = (t.items||[]).filter(i => i.type==='blob' || i.type==='tree');

    // Build nested structure (no fake root row)
    function makeNode(name, type, fullPath){
      return { name, type, path: fullPath, children: new Map() };
    }
    const root = makeNode('', 'tree', '');

    for (const i of items) {
      const parts = i.path.split('/');
      let cur = root;
      for (let p = 0; p < parts.length; p++){
        const seg = parts[p];
        const isLast = p === parts.length - 1;
        const nodeType = isLast ? i.type : 'tree';
        const childPath = parts.slice(0, p+1).join('/');
        if (!cur.children.has(seg)) cur.children.set(seg, makeNode(seg, nodeType, childPath));
        cur = cur.children.get(seg);
      }
    }

    function renderNode(node){
      if (node.type === 'blob') {
        const li = document.createElement('li');
        li.className = 'file';
        li.dataset.path = node.path;
        li.innerHTML = `
          <div class="row">
            <span class="twisty"></span>
            <input type="checkbox" class="sel" data-path="${node.path}" />
            <span class="icon">📄</span>
            <a href="#" data-file="${node.path}" class="name">${node.name}</a>
          </div>`;
        return li;
      } else {
        const li = document.createElement('li');
        li.className = 'dir collapsed'; /* collapsed by default */
        li.dataset.path = node.path;
        const label = node.name || '';
        li.innerHTML = `
          <div class="row">
            <span class="twisty"></span>
            <input type="checkbox" class="sel" data-path="${node.path}" />
            <span class="icon">📁</span>
            <span class="name">${label}</span>
          </div>
          <ul class="children"></ul>`;
        const ul = li.querySelector('.children');

        const children = Array.from(node.children.values())
          .sort((a,b)=>{
            if (a.type!==b.type) return a.type==='tree' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });

        for (const c of children) ul.appendChild(renderNode(c));
        return li;
      }
    }

    const ulRoot = document.createElement('ul');
    const topChildren = Array.from(root.children.values())
      .sort((a,b)=>{
        if (a.type!==b.type) return a.type==='tree' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    for (const c of topChildren) ulRoot.appendChild(renderNode(c));

    treeEl.innerHTML = '';
    treeEl.appendChild(ulRoot);

    // --- Delegated handlers (set once per render using .onclick/.onchange) ---
    treeEl.onclick = async (e)=>{
      // Expand/collapse on folder twisty/name
      const twisty = e.target.closest('.twisty');
      const name = e.target.closest('.name');
      const dirLi = (twisty || name) ? (twisty||name).closest('li.dir') : null;
      if (dirLi) {
        dirLi.classList.toggle('collapsed');
        dirLi.classList.toggle('open');
        return;
      }

      // File click => open or emit
      const a = e.target.closest('a[data-file]');
      if (a) {
        e.preventDefault();
        const f = a.dataset.file;
        if (isSide) {
          window.parent?.postMessage({ type:'MODULE_EVENT', eventName:'gh:file-selected', payload:{ path: f } }, '*');
        } else {
          await openFile(f);
        }
      }
    };

    const selCountChip = $('selCountChip');

    function setSubtreeChecked(li, checked) {
      li.querySelectorAll('input.sel').forEach(cb => {
        cb.checked = checked;
        cb.indeterminate = false;
      });
    }
    function updateAncestors(fromLi) {
      const parentDir = fromLi.closest('ul')?.closest('li.dir');
      if (!parentDir) return;

      // ONLY consider direct child rows of this directory (not deep descendants)
      const childCbs = Array
        .from(parentDir.querySelectorAll(':scope > ul > li > .row input.sel'));

      const allChecked = childCbs.length>0 && childCbs.every(cb => cb.checked);
      const noneChecked = childCbs.every(cb => !cb.checked && !cb.indeterminate);
      const parentCb = parentDir.querySelector(':scope > .row input.sel');

      parentCb.checked = allChecked;
      parentCb.indeterminate = !allChecked && !noneChecked;

      updateAncestors(parentDir);
    }
    function collectSelectedFiles() {
      return Array.from(treeEl.querySelectorAll('li.file input.sel:checked'))
        .map(cb => cb.dataset.path);
    }
    function updateSelectionBadgeAndEmit() {
      const files = collectSelectedFiles();
      if (selCountChip) selCountChip.textContent = `${files.length} selected`;
      if (isSide) {
        window.parent?.postMessage({ type:'MODULE_EVENT', eventName:'gh:selection-changed', payload:{ files } }, '*');
      }
    }

    treeEl.onchange = (e)=>{
      const cb = e.target;
      if (!cb.matches('input.sel')) return;
      const li = cb.closest('li');
      if (li?.classList.contains('dir')) {
        setSubtreeChecked(li, cb.checked);
      }
      updateAncestors(li);
      updateSelectionBadgeAndEmit();
    };

    // Expand/Collapse all (overwrite handlers each render to avoid dupes)
    $('expandAllBtn').onclick = ()=>{
      treeEl.querySelectorAll('li.dir').forEach(li=>{
        li.classList.remove('collapsed'); li.classList.add('open');
      });
    };
    $('collapseAllBtn').onclick = ()=>{
      treeEl.querySelectorAll('li.dir').forEach(li=>{
        li.classList.remove('open'); li.classList.add('collapsed');
      });
    };

  }catch(e){
    treeEl.innerHTML = `<div class="muted">Failed to load tree: ${e.message}</div>`;
  }
}

// ---------- one-time UI wiring ----------
let _wired = false;
function wireUIOnce(){
  if (_wired) return;
  _wired = true;
  $('saveCfgBtn')?.addEventListener('click', saveConfig);
  $('reloadBtn')?.addEventListener('click', loadTree);
  $('saveFileBtn')?.addEventListener('click', saveFile);
  $('branchSelect')?.addEventListener('change', loadTree);
}

// Init
window.addEventListener('DOMContentLoaded', async ()=>{
  wireUIOnce();
  await loadConfig();     // reads saved config (if any)
  await loadBranches();   // populates branch list
  await loadTree();       // builds collapsed tree
});
