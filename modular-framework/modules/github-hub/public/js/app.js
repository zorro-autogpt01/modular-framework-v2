const $ = (id)=>document.getElementById(id);
const isSide = new URLSearchParams(location.search).get('embed') === 'side';

// Figure out the module base (works standalone and when proxied)
// Examples:
//  - http://host:3005/ui/           -> API = /api
//  - http://host:3005/              -> API = /api
//  - http://framework/api/v1/github/ui/ -> API = /api/v1/github/api
//  - http://framework/api/v1/github/    -> API = /api/v1/github/api
const API = (() => {
  const p = location.pathname;

  // If we’re under /.../ui/..., strip the /ui part
  const idx = p.indexOf('/ui/');
  if (idx !== -1) return p.slice(0, idx) + '/api';

  // If we’re already under a proxied prefix like /api/v1/github/...
  const m = p.match(/^(.*?\/api\/github-hub)(?:\/|$)/);
  if (m) return `${m[1]}/api`;

  // Standalone (served from module root)
  return '/api';
})();

// --- file-content cache (per branch:path) ---
const fileCache = new Map();

/** Robust tokenizer loader with local+CDN fallback and safe approximation */
let _encPromise = null;
let HAS_MULTI = false;
let EDITING_CONN = null;

function slugify(s){
  return (s||'').toLowerCase()
    .replace(/https?:\/\/github\.com\//,'')
    .replace(/[^\w\-]+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^-|-$/g,'');
}

async function getEncoder() {
  if (!_encPromise) {
    _encPromise = (async () => {
      try {
        // Try the lite ESM first
        const { Tiktoken } = await import('https://cdn.jsdelivr.net/npm/js-tiktoken@1.0.21/lite.js');

        // Prefer a local copy (add one later if you like), else fall back to CDN JSON
        // Local (optional): place o200k_base.json under /public/js/tiktoken/
        let ranksRes;
        try {
          ranksRes = await fetch('./js/tiktoken/o200k_base.json', { cache: 'force-cache' });
          if (!ranksRes.ok) throw new Error('local ranks missing');
        } catch {
          // CDN fallback
          ranksRes = await fetch('https://tiktoken.pages.dev/js/o200k_base.json', { cache: 'force-cache' });
        }

        const ranks = await ranksRes.json();
        return new Tiktoken(ranks);
      } catch (e) {
        console.warn('[github-hub] Tokenizer unavailable, using approximation:', e);
        return null; // signal fallback
      }
    })();
  }
  return _encPromise;
}

async function countTokensFor(text) {
  const enc = await getEncoder();
  if (enc) {
    try { return enc.encode(text).length; }
    catch (e) { console.warn('[github-hub] encode failed, approx fallback:', e); }
  }
  // Approx fallback: ~4 chars per token (rough heuristic)
  return Math.ceil(text.length / 4);
}

/** Fetch file content (cached per branch+path) */
async function getFileContent(path, branch) {
  const key = `${branch}:${path}`;
  if (fileCache.has(key)) return fileCache.get(key);
  const data = await api(`/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`);
  const content = data.decoded_content || '';
  fileCache.set(key, content);
  return content;
}

/** Build clipboard text with a header line BEFORE EACH file */
async function buildClipboardText(paths, branch) {
  const parts = [];
  for (const p of paths) {
    const name = p.split('/').pop() || p;
    parts.push(`# ${p}\n`);                       // header for this file
    const content = await getFileContent(p, branch);
    parts.push(content.endsWith('\n') ? content : content + '\n');
    // optional extra blank line between files (comment out if undesired)
    parts.push('\n');
  }
  return parts.join('');
}


let ACTIVE_CONN = null;   // current connection id (null => default)
const endpointProbeCache = new Map();

async function hasEndpoint(path) {
  // checks for 2xx/3xx, caches per path
  if (endpointProbeCache.has(path)) return endpointProbeCache.get(path);
  try {
    const r = await fetch(`${API}${path}`, { method: 'OPTIONS' });
    const ok = r.ok || (r.status >= 200 && r.status < 400);
    endpointProbeCache.set(path, ok);
    return ok;
  } catch {
    endpointProbeCache.set(path, false);
    return false;
  }
}

async function api(path, init) {
  // Build absolute URL so we can mutate search params safely
  const url = new URL(`${API}${path}`, location.origin);

  // If the caller already set conn_id explicitly, respect it. Otherwise inject ACTIVE_CONN.
  if (ACTIVE_CONN && !url.searchParams.has('conn_id')) {
    url.searchParams.set('conn_id', ACTIVE_CONN);
  }

  const headers = { ...(init?.headers || {}), 'X-Requested-With': 'github-hub' };
  if (ACTIVE_CONN) headers['X-GH-Conn'] = ACTIVE_CONN;

  const res = await fetch(url.toString(), { ...init, headers });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadConnections() {
  const sel = $('connSelect');
  const manageBtn = $('manageConnsBtn');

  // Try new multi-conn endpoint first
  let multi = false;
  try {
    const r = await api('/connections');
    const conns = r.connections || [];
    const def = r.default_id || r.defaultId || null;

    sel.innerHTML = '';
    conns.forEach(c => {
      const o = new Option(c.name || c.id || c.repo_url, c.id);
      sel.appendChild(o);
    });
    ACTIVE_CONN = def || conns[0]?.id || null;
    if (ACTIVE_CONN) sel.value = ACTIVE_CONN;

    manageBtn.disabled = false;
    HAS_MULTI = true;
   const active = conns.find(c => c.id === (ACTIVE_CONN || def)) || conns[0];
   if (active) {
     $('repoUrl').value = (active.repo_url || '').replace(/\/+$/,'');
     $('baseUrl').value = active.base_url || 'https://api.github.com';
   }
    multi = true;
  } catch {
    // Fallback to legacy single-connection config
    const c = await api('/config');
    sel.innerHTML = '';
    const o = new Option((c.repo_url || 'Default').replace(/\/+$/,''), 'default');
    sel.appendChild(o);
    ACTIVE_CONN = null;            // legacy: no conn_id
    sel.value = 'default';
    manageBtn.disabled = true;     // disable manager when backend lacks it
    HAS_MULTI = false;
  }

  // show/hide manage button
  if (!multi) manageBtn.classList.add('hidden'); else manageBtn.classList.remove('hidden');
}

function toast(msg, ok = true) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg;
  t.style.borderColor = ok ? '#2d7d46' : '#a1260d';
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2000);
}

function openModal(id){ $(id)?.classList.add('show'); }
function closeModal(id){ $(id)?.classList.remove('show'); }

async function openConnManager() {
  try {
    const r = await api('/connections');
    const list = r.connections || [];
    const def = r.default_id || r.defaultId;
    const box = $('connList');
    if (!box) return;

    if (!list.length) {
      box.innerHTML = '<div class="muted">No connections yet.</div>';
      return;
    }

    box.innerHTML = list.map(c => {
      const isDef = c.id === def;
      return `
        <div class="item" style="display:flex;gap:8px;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin:6px 0">
          <div>
            <strong>${c.name || c.id}</strong>
            <div class="muted">${(c.repo_url||'').replace(/\/+$/,'')} • ${c.default_branch || 'main'}</div>
          </div>
          <div>
            <button class="ghost" data-default="${c.id}" ${isDef?'disabled':''}>${isDef?'Default':'Make default'}</button>
            <button class="ghost" data-edit="${c.id}">Edit</button>
            <button class="danger" data-del="${c.id}">Delete</button>
          </div>
        </div>`;
    }).join('');

    // wire actions
    box.querySelectorAll('button[data-default]')?.forEach(b => b.onclick = async () => {
      const id = b.getAttribute('data-default');
      try { await api(`/connections/${encodeURIComponent(id)}/default`, { method:'POST' });await api(`/connections/${encodeURIComponent(id)}/default`, { method:'PUT' }); toast('Default updated'); await loadConnections(); await openConnManager(); } catch(e){ toast(e.message,false); }
    });
    box.querySelectorAll('button[data-del]')?.forEach(b => b.onclick = async () => {
      const id = b.getAttribute('data-del');
      if (!confirm('Delete connection?')) return;
      try { await api(`/connections/${encodeURIComponent(id)}`, { method:'DELETE' }); toast('Deleted'); await loadConnections(); await openConnManager(); } catch(e){ toast(e.message,false); }
    });
    box.querySelectorAll('button[data-edit]')?.forEach(b => b.onclick = async () => {
      const id = b.getAttribute('data-edit');
      const c = (r.connections||[]).find(x => x.id === id);
      if (!c) return;
      EDITING_CONN = id;
      $('mId').value = c.id || '';
      $('mName').value = c.name || '';
      $('mRepo').value = c.repo_url || '';
      $('mBranch').value = c.default_branch || 'main';
      $('mBase').value = c.base_url || 'https://api.github.com';
      $('mTok').value = ''; // never prefill token
    });

    openModal('connModal');
  } catch {
    toast('Multi-connection API not available', false);
  }
}



export async function loadConfig(){
  try{
    const c = await api("/config");
    $('repoUrl').value = c.repo_url || '';
    $('baseUrl').value = c.base_url || 'https://api.github.com';
    //await loadBranches();
  }catch(e){ console.warn(e); }
}

export async function saveConfig(){
  const repo_url = $('repoUrl').value.trim();
  const default_branch = $('branchSelect').value || 'main';
  const base_url = $('baseUrl').value.trim() || 'https://api.github.com';
  const token = $('token').value.trim();

  if (HAS_MULTI) {
    const id = ACTIVE_CONN || slugify(repo_url) || 'default';
    const b = { id, repo_url, default_branch, base_url };
    if (token) b.token = token;
    await api('/connections', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(b) });
    toast('Connection saved');
    await loadConnections();
  } else {
    await api('/config', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ repo_url, default_branch, base_url, token: token || undefined })
    });
  }
  $('token').value = '';
  await loadBranches();
  await loadTree();
}

export async function loadBranches(){
  const sel = $('branchSelect');
  sel.innerHTML = '';
  try{
    const b = await api("/branches");
    const names = Array.from(new Set((b.branches||[])));
    names.forEach(name=>{
      const o = document.createElement('option');
      o.value = o.textContent = name;
      sel.appendChild(o);
    });
  }catch(e){
    // fallback options
    ['main','master'].forEach(n=>{
      const o = document.createElement('option');
      o.value = o.textContent = n;
      sel.appendChild(o);
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

function matchFilter(path, value) {
  if (!value) return true;
  const v = value.trim();
  if (v.startsWith('/') && v.endsWith('/') && v.length > 2) {
    try { return new RegExp(v.slice(1,-1), 'i').test(path); }
    catch { return true; }
  }
  return path.toLowerCase().includes(v.toLowerCase());
}

function applyFilter(){
  const treeEl = $('tree'); const q = $('filterInput')?.value || '';
  if (!treeEl) return;
  // toggle files
  treeEl.querySelectorAll('li.file').forEach(li=>{
    const p = li.dataset.path || '';
    li.style.display = matchFilter(p, q) ? '' : 'none';
  });
  // toggle directories with no visible children
  treeEl.querySelectorAll('li.dir').forEach(li=>{
    const hasVisible = li.querySelector(':scope li.file:not([style*="display: none"])') ||
                       li.querySelector(':scope li.dir:not([style*="display: none"])');
    li.style.display = hasVisible ? '' : 'none';
  });
}

async function createPR(){
  const title = $('prTitle').value.trim();
  const head  = $('prHead').value.trim();
  const base  = $('prBase').value.trim() || 'main';
  const body  = $('prBody').value;
  const draft = $('prDraft').value === 'true';

  if (!title || !head) { toast('Title and head are required', false); return; }

  try{
    const res = await api('/pr', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ title, head, base, body, draft })
    });
    const url = res?.pull_request?.html_url || '';
    toast('PR created');
    closeModal('prModal');
    if (url) window.open(url, '_blank');
  }catch(e){
    toast(`PR failed: ${e.message}`, false);
  }
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
    const copyBtn = $('copyBtn');
    const tokenCountChip = $('tokenCountChip');

    function setSubtreeChecked(li, checked) {
      li.querySelectorAll('input.sel').forEach(cb => {
        cb.checked = checked;
        cb.indeterminate = false;
      });
    }
    function updateAncestors(fromLi) {
      const parentDir = fromLi.closest('ul')?.closest('li.dir');
      if (!parentDir) return;

      const childCbs = Array.from(parentDir.querySelectorAll(':scope > ul > li > .row input.sel'));
      const allChecked = childCbs.length > 0 && childCbs.every(cb => cb.checked);
      const noneChecked = childCbs.every(cb => !cb.checked && !cb.indeterminate);
      const parentCb = parentDir.querySelector(':scope > .row input.sel');

      parentCb.checked = allChecked;
      parentCb.indeterminate = !allChecked && !noneChecked;

      updateAncestors(parentDir);
    }
    function collectSelectedFiles() {
      return Array.from(treeEl.querySelectorAll('li.file input.sel:checked')).map(cb => cb.dataset.path);
    }

    /** Recompute token count for the EXACT text that will be copied */
    async function recalcTokensUI() {
      if (!tokenCountChip || !copyBtn) return;
      const files = collectSelectedFiles();
      const branch = $('branchSelect').value || 'main';

      if (files.length === 0) {
        tokenCountChip.textContent = '0 tokens';
        copyBtn.disabled = true;
        return;
      }

      copyBtn.disabled = false;
      tokenCountChip.textContent = '…'; // show work in progress
      try {
        const text = await buildClipboardText(files, branch);
        const n = await countTokensFor(text);
        tokenCountChip.textContent = `${n} tokens`;
      } catch (e) {
        console.warn('[github-hub] token recalc failed:', e);
        tokenCountChip.textContent = '—';
      }
    }

    function updateSelectionBadgeAndEmit() {
      const files = collectSelectedFiles();
      if (selCountChip) selCountChip.textContent = `${files.length} selected`;
      if (isSide) {
        window.parent?.postMessage(
          { type:'MODULE_EVENT', eventName:'gh:selection-changed', payload:{ files } },
          '*'
        );
      }
      // keep tokens in sync
      recalcTokensUI();
    }

    treeEl.onchange = (e) => {
      const cb = e.target;
      if (!cb.matches('input.sel')) return;
      const li = cb.closest('li');
      if (li?.classList.contains('dir')) {
        setSubtreeChecked(li, cb.checked);
      }
      updateAncestors(li);
      updateSelectionBadgeAndEmit();
    };

    // Copy to clipboard with headers
    copyBtn.onclick = async () => {
      const files = collectSelectedFiles();
      if (files.length === 0) {
        alert('Select one or more files in the tree first.');
        return;
      }
      const branch = $('branchSelect').value || 'main';
      const text = await buildClipboardText(files, branch);

      try {
        await navigator.clipboard.writeText(text);
        const old = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = old), 1000);
      } catch {
        // Fallback for older browsers / HTTP
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
    };

    // initialize chips on first render
    updateSelectionBadgeAndEmit();


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
  applyFilter();
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

  $('connSelect')?.addEventListener('change', async (e) => {
    ACTIVE_CONN = (e.target.value === 'default') ? null : e.target.value;
    await loadBranches();
    await loadTree();
  });
  $('manageConnsBtn')?.addEventListener('click', openConnManager);
  $('closeConnBtn')?.addEventListener('click', ()=> closeModal('connModal'));
  $('saveConnBtn')?.addEventListener('click', async ()=>{
  const id = $('mId').value.trim() || EDITING_CONN ||
             slugify($('mName').value) || slugify($('mRepo').value) ||
             ('conn-' + Date.now());
  const body = {
    id,
      name: $('mName').value.trim(),
      repo_url: $('mRepo').value.trim(),
      default_branch: $('mBranch').value.trim() || 'main',
      base_url: $('mBase').value.trim() || 'https://api.github.com'
    };
    const tok = $('mTok').value.trim(); if (tok) body.token = tok;
    try {
      await api('/connections', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
      toast('Connection saved');
      $('mTok').value = '';
      $('mId').value = '';
      EDITING_CONN = null;
      closeModal('connModal');
      await loadConnections();
      await loadBranches();
      await loadTree();
    } catch (e) { toast(e.message, false); }
  });

  $('openPrBtn')?.addEventListener('click', ()=> openModal('prModal'));
  $('closePrBtn')?.addEventListener('click', ()=> closeModal('prModal'));
  $('createPrBtn')?.addEventListener('click', createPR);

  $('filterInput')?.addEventListener('input', applyFilter);
}

// Init
window.addEventListener('DOMContentLoaded', async ()=>{
  wireUIOnce();
  await loadConfig();     // legacy config still supported
  await loadConnections();// populate connSelect (multi or legacy)
  await loadBranches();   // uses ACTIVE_CONN via api()
  await loadTree();       // builds tree
});


