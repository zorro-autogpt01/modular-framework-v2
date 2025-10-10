const $ = (id)=>document.getElementById(id);
const isSide = new URLSearchParams(location.search).get('embed') === 'side';

// Figure out the module base (works standalone and when proxied)
const API = (() => {
  const p = location.pathname;
  // When served under a gateway like /api/v1/github/ui, anchor API at /api/v1/github/api
  // When served standalone at /ui, anchor API at /api
  const uiIdx = p.indexOf('/ui/');
  if (uiIdx !== -1) return p.slice(0, uiIdx) + '/api';
  const m = p.match(/^(.*?\/api\/v1\/github)(?:\/|$)/);
  if (m) return `${m[1]}/api`;
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
    .replace(/[^a-z0-9\-_.]+/g,'-')
    .replace(/-+/g,'-')
    .replace(/^-|-$/g,'');
}

function isHttpUrl(u){
  return typeof u === 'string' && (u.startsWith('http://') || u.startsWith('https://'));
}

function looksLikeRepoUrl(u){
  if (!u || typeof u !== 'string') return false;
  const s = u.trim();
  if (s.startsWith('git@') && s.includes(':')) return true;
  if (isHttpUrl(s) && s.split('/').filter(Boolean).length >= 4) return true; // scheme + host + owner + repo
  return false;
}

function validateConnInput({ id, repo_url, base_url, token }){
  const errs = [];
  if (id && !/^[a-z0-9._\-]{1,128}$/.test(id)) errs.push('ID must be a slug (lowercase letters, numbers, . _ -)');
  if (!looksLikeRepoUrl(repo_url)) errs.push('Repo URL must be https://.../owner/repo or git@host:owner/repo');
  if (base_url && !isHttpUrl(base_url)) errs.push('Base API URL must start with http:// or https://');
  if (token && token.length < 20) errs.push('Token looks too short');
  return errs;
}

async function testConnectionPayload(payload){
  // Note: do not attach conn_id to validation endpoint
  const res = await api('/connections/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo_url: payload.repo_url, base_url: payload.base_url, token: payload.token || undefined })
  }, { noConn: true });
  return res;
}

async function getEncoder() {
  if (!_encPromise) {
    _encPromise = (async () => {
      try {
        const { Tiktoken } = await import('https://cdn.jsdelivr.net/npm/js-tiktoken@1.0.21/lite.js');
        let ranksRes;
        try {
          ranksRes = await fetch('./js/tiktoken/o200k_base.json', { cache: 'force-cache' });
          if (!ranksRes.ok) throw new Error('local ranks missing');
        } catch {
          ranksRes = await fetch('https://tiktoken.pages.dev/js/o200k_base.json', { cache: 'force-cache' });
        }
        const ranks = await ranksRes.json();
        return new Tiktoken(ranks);
      } catch (e) {
        console.warn('[github-hub] Tokenizer unavailable, using approximation:', e);
        return null;
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
    parts.push(`# ${p}\n`);
    const content = await getFileContent(p, branch);
    parts.push(content.endsWith('\n') ? content : content + '\n');
    parts.push('\n');
  }
  return parts.join('');
}

let ACTIVE_CONN = null;   // current connection id (null => default)
const endpointProbeCache = new Map();

async function hasEndpoint(path) {
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

async function api(path, init, opts) {
  const url = new URL(`${API}${path}`, location.origin);
  const noConn = opts?.noConn || false;
  if (!noConn && ACTIVE_CONN && !url.searchParams.has('conn_id')) {
    url.searchParams.set('conn_id', ACTIVE_CONN);
  }
  const headers = { ...(init?.headers || {}), 'X-Requested-With': 'github-hub' };
  if (!noConn && ACTIVE_CONN) headers['X-GH-Conn'] = ACTIVE_CONN;

  const res = await fetch(url.toString(), { ...init, headers });
  if (!res.ok) {
    let errText = '';
    try { errText = await res.text(); } catch {}
    // Surface server-provided details if any
    throw new Error(errText || `HTTP ${res.status}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { ok: true, raw: t }; }
}

async function loadConnections() {
  const sel = $('connSelect');
  const manageBtn = $('manageConnsBtn');

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
    // Fallback single-connection mode
    try {
      const c = await api('/config', undefined, { noConn: true });
      const defId = c.default_id || c.defaultId || null;
      const d = (c.connections || []).find(x => x.id === defId) || (c.connections || [])[0] || {};
      $('repoUrl').value = (d.repo_url || c.repo_url || '').replace(/\/+$/,'');
      $('baseUrl').value = d.base_url || c.base_url || 'https://api.github.com';

      sel.innerHTML = '';
      const o = new Option((d.name || d.id || d.repo_url || 'Default').replace(/\/+$/,''), 'default');
      sel.appendChild(o);
      ACTIVE_CONN = null;
      sel.value = 'default';
      manageBtn.disabled = true;
      HAS_MULTI = false;
    } catch (e) {
      console.warn(e);
    }
  }
  if (!multi) manageBtn.classList.add('hidden'); else manageBtn.classList.remove('hidden');
}

function toast(msg, ok = true) {
  const t = $('toast'); if (!t) { alert(msg); return; }
  t.textContent = msg;
  t.style.borderColor = ok ? '#2d7d46' : '#a1260d';
  t.classList.add('show');
  setTimeout(()=> t.classList.remove('show'), 2200);
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
      const bcount = (c.branches || []).length;
      return `
        <div class="item" style="display:flex;gap:8px;align-items:center;justify-content:space-between;border:1px solid var(--line);border-radius:6px;padding:6px 8px;margin:6px 0">
          <div>
            <strong>${c.name || c.id}</strong>
            <div class="muted">${(c.repo_url||'').replace(/\/+$/,'')} • ${c.default_branch || 'main'} • ${bcount} branches</div>
          </div>
          <div>
            <button class="ghost" data-default="${c.id}" ${isDef?'disabled':''}>${isDef?'Default':'Make default'}</button>
            <button class="ghost" data-edit="${c.id}">Edit</button>
            <button class="danger" data-del="${c.id}">Delete</button>
          </div>
        </div>`;
    }).join('');

    box.querySelectorAll('button[data-default]')?.forEach(b => b.onclick = async () => {
      const id = b.getAttribute('data-default');
      try {
        await api(`/connections/${encodeURIComponent(id)}/default`, { method:'POST' });
        await api(`/connections/${encodeURIComponent(id)}/default`, { method:'PUT' });
        toast('Default updated');
        await loadConnections(); await openConnManager();
      } catch(e){ toast(e.message,false); }
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
      $('mTok').value = '';
    });

    openModal('connModal');
  } catch {
    toast('Multi-connection API not available', false);
  }
}

export async function loadConfig(){
  try{
    const c = await api('/config', undefined, { noConn: true });
    const defId = c.default_id || c.defaultId || null;
    const d = (c.connections || []).find(x => x.id === defId) || (c.connections || [])[0] || {};
    $('repoUrl').value = (d.repo_url || c.repo_url || '').replace(/\/+$/,'');
    $('baseUrl').value = d.base_url || c.base_url || 'https://api.github.com';
  }catch(e){ console.warn(e); }
}

async function testCurrentConfig(){
  const payload = {
    repo_url: $('repoUrl').value.trim(),
    base_url: $('baseUrl').value.trim() || 'https://api.github.com',
    token: $('token').value.trim() || undefined
  };
  const errs = validateConnInput({ id: 'tmp', ...payload });
  if (errs.length) { toast(errs[0], false); return; }
  try {
    const res = await testConnectionPayload(payload);
    toast(`OK • ${res.branches?.length || 0} branches`);
    await loadBranches(res.branches);
  } catch (e) {
    toast(e.message, false);
  }
}

export async function saveConfig(){
  const repo_url = $('repoUrl').value.trim();
  const default_branch = $('branchSelect').value || '';
  const base_url = $('baseUrl').value.trim() || 'https://api.github.com';
  const token = $('token').value.trim();

  const id = HAS_MULTI ? (ACTIVE_CONN || slugify(repo_url) || 'default') : 'default';
  const payload = { id, repo_url, default_branch: default_branch || undefined, base_url, token: token || undefined };
  const errs = validateConnInput(payload);
  if (errs.length) { toast(errs[0], false); return; }

  // Test before saving
  try {
    const testRes = await testConnectionPayload({ repo_url, base_url, token });
    if (!payload.default_branch) payload.default_branch = testRes.default_branch || 'main';
  } catch (e) {
    toast(`Validation failed: ${e.message}`, false);
    return;
  }

  if (HAS_MULTI) {
    await api('/connections', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    toast('Connection saved');
    $('token').value = '';
    await loadConnections();
  } else {
    await api('/config', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ repo_url, default_branch: payload.default_branch, base_url, token: token || undefined }) }, { noConn: true });
  }
  await loadBranches();
  await loadTree();
}

export async function loadBranches(prefetched = null){
  const sel = $('branchSelect');
  sel.innerHTML = '';
  try{
    const b = prefetched ? { branches: prefetched } : await api('/branches');
    const names = Array.from(new Set((b.branches||[])));
    if (!names.length) throw new Error('No branches');
    names.forEach(name=>{
      const o = document.createElement('option');
      o.value = o.textContent = name;
      sel.appendChild(o);
    });
  }catch(e){
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
  treeEl.querySelectorAll('li.file').forEach(li=>{
    const p = li.dataset.path || '';
    li.style.display = matchFilter(p, q) ? '' : 'none';
  });
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
        li.className = 'dir collapsed';
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

    treeEl.onclick = async (e)=>{
      const twisty = e.target.closest('.twisty');
      const name = e.target.closest('.name');
      const dirLi = (twisty || name) ? (twisty||name).closest('li.dir') : null;
      if (dirLi) {
        dirLi.classList.toggle('collapsed');
        dirLi.classList.toggle('open');
        return;
      }
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
      tokenCountChip.textContent = '…';
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

    updateSelectionBadgeAndEmit();

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
  $('testCfgBtn')?.addEventListener('click', testCurrentConfig);
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
  $('testConnModalBtn')?.addEventListener('click', async ()=>{
    const id = $('mId').value.trim() || slugify($('mName').value) || slugify($('mRepo').value) || ('conn-' + Date.now());
    const body = {
      id,
      name: $('mName').value.trim(),
      repo_url: $('mRepo').value.trim(),
      default_branch: $('mBranch').value.trim() || undefined,
      base_url: $('mBase').value.trim() || 'https://api.github.com'
    };
    const tok = $('mTok').value.trim(); if (tok) body.token = tok;
    const errs = validateConnInput(body);
    if (errs.length) { toast(errs[0], false); return; }
    try {
      const res = await testConnectionPayload({ repo_url: body.repo_url, base_url: body.base_url, token: body.token });
      toast(`OK • ${res.branches?.length || 0} branches`);
    } catch(e) {
      toast(e.message, false);
    }
  });
  $('saveConnBtn')?.addEventListener('click', async ()=>{
    const id = $('mId').value.trim() || EDITING_CONN || slugify($('mName').value) || slugify($('mRepo').value) || ('conn-' + Date.now());
    const body = {
      id,
      name: $('mName').value.trim(),
      repo_url: $('mRepo').value.trim(),
      default_branch: $('mBranch').value.trim() || undefined,
      base_url: $('mBase').value.trim() || 'https://api.github.com'
    };
    const tok = $('mTok').value.trim(); if (tok) body.token = tok;
    const errs = validateConnInput(body);
    if (errs.length) { toast(errs[0], false); return; }
    try {
      await testConnectionPayload({ repo_url: body.repo_url, base_url: body.base_url, token: body.token });
    } catch (e) {
      toast(`Validation failed: ${e.message}`, false);
      return;
    }
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
  await loadConfig();
  await loadConnections();
  await loadBranches();
  await loadTree();
});
