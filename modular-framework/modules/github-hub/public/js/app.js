const $ = (id)=>document.getElementById(id);

function basePath(){
  // works whether proxied at /api/github-hub/ or standalone
  const p = window.location.pathname;
  return p.endsWith('/') ? p.slice(0,-1) : p;
}
const API = basePath() + "/api";

async function api(path, init){
  const r = await fetch(API+path, init);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function loadConfig(){
  try{
    const c = await api("/config");
    $('repoUrl').value = c.repo_url || '';
    $('baseUrl').value = c.base_url || 'https://api.github.com';
    await loadBranches();
  }catch(e){ console.warn(e); }
}

async function saveConfig(){
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
  $('token').value = ''; // don't keep in DOM
  await loadBranches();
  await loadTree();
}

async function loadBranches(){
  const sel = $('branchSelect');
  sel.innerHTML = '';
  try{
    const b = await api("/branches");
    (b.branches||[]).forEach(name=>{
      const o = document.createElement('option'); o.value=o.textContent = name; sel.appendChild(o);
    });
  }catch(e){
    // default
    ['main','master'].forEach(n=>{
      const o = document.createElement('option'); o.value=o.textContent = n; $('branchSelect').appendChild(o);
    });
  }
}

async function loadTree(){
  $('tree').innerHTML = '<div class="muted">Loading…</div>';
  try{
    const branch = $('branchSelect').value || 'main';
    const t = await api(`/tree?branch=${encodeURIComponent(branch)}&recursive=true`);
    const items = (t.items||[]).filter(i=>i.type==='blob' || i.type==='tree');
    // Basic grouped folder view
    const ul = document.createElement('div');
    items.sort((a,b)=>a.path.localeCompare(b.path));
    items.forEach(i=>{
      const div = document.createElement('div');
      div.className = 'item';
      const isDir = i.type==='tree';
      div.innerHTML = `
        <input type="checkbox" class="sel" data-path="${i.path}" ${isDir?'disabled':''}/>
        <span>${isDir?'📁':'📄'}</span>
        <a href="#" data-file="${!isDir ? i.path : ''}" data-dir="${isDir ? i.path : ''}">${i.path}</a>`;
      ul.appendChild(div);
    });
    $('tree').innerHTML = ''; $('tree').appendChild(ul);

    // click handlers
    $('tree').querySelectorAll('a').forEach(a=>{
      a.addEventListener('click', async (e)=>{
        e.preventDefault();
        const f = a.dataset.file;
        if (f){
          await openFile(f);
        } else {
          // filter view by dir prefix
          const dir = a.dataset.dir + "/";
          $('tree').querySelectorAll('.item').forEach(n=>{
            const p = n.querySelector('a')?.textContent || '';
            n.style.display = p.startsWith(dir) || p===dir.slice(0,-1) ? '' : 'none';
          });
        }
      });
    });
  }catch(e){
    $('tree').innerHTML = `<div class="muted">Failed to load tree: ${e.message}</div>`;
  }
}

let currentFile = null;
let currentSha = null;

async function openFile(path){
  const branch = $('branchSelect').value || 'main';
  const data = await api(`/file?path=${encodeURIComponent(path)}&branch=${encodeURIComponent(branch)}`);
  currentFile = path;
  currentSha = data.sha;
  $('fileMeta').textContent = `${path} @ ${branch} (sha ${data.sha?.slice(0,7)})`;
  $('fileView').textContent = data.decoded_content || '';
}

async function saveFile(){
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

$('saveCfgBtn')?.addEventListener('click', saveConfig);
$('reloadBtn')?.addEventListener('click', loadTree);
$('saveFileBtn')?.addEventListener('click', saveFile);
$('branchSelect')?.addEventListener('change', loadTree);

document.addEventListener('DOMContentLoaded', async ()=>{
  await loadConfig();
  await loadTree();
});
