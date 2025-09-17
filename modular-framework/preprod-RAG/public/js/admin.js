// public/js/admin.js
const $ = (id)=> document.getElementById(id);
const api = (p, init)=> fetch(p, init).then(r => r.ok ? r.json() : Promise.reject(r));
const API = '/admin-api';

function showTab(name){
  document.querySelectorAll('.main-tabs .tab').forEach(b=>{
    b.classList.toggle('active', b.dataset.tab===name);
  });
  document.querySelectorAll('section.pane').forEach(s=>{
    s.style.display = (s.id===name) ? '' : 'none';
  });
}

document.querySelectorAll('.main-tabs .tab').forEach(btn=>{
  btn.addEventListener('click', ()=> showTab(btn.dataset.tab));
});

async function loadStats(){
  // /stats and /health are top-level (not under /admin/api)
  try {
    const s = await api('/stats');
    $('s_code')     && ($('s_code').textContent    = s.code_chunks ?? '0');
    $('s_docs')     && ($('s_docs').textContent    = s.documents_chunks ?? s.document_chunks ?? '0');
    $('s_convos')   && ($('s_convos').textContent  = s.conversations_chunks ?? '0');
    $('s_total')    && ($('s_total').textContent   = s.total_chunks ?? '0');
  } catch {
    // noop
  }

  try {
    const h = await api('/health');
    $('healthBox') && ($('healthBox').textContent = JSON.stringify(h, null, 2));
  } catch {
    $('healthBox') && ($('healthBox').textContent = 'unavailable');
  }

  try {
    const info = await api(`${API}/info`);
    $('infoBox') && ($('infoBox').textContent = JSON.stringify(info, null, 2));
    $('set_chunk_size') && ($('set_chunk_size').textContent = info.chunking?.chunk_size ?? '—');
    $('set_overlap')    && ($('set_overlap').textContent    = info.chunking?.overlap ?? '—');
  } catch {
    // noop
  }
}

async function loadSources(){
  try {
    const repos = await api(`${API}/repos`);
    const items = repos.items ?? [];
    $('repoList') && ($('repoList').innerHTML =
      items.map(r=>`
        <div class="row">
          <div>
            <strong>${r.repo || '(unknown)'}</strong>
            <div class="muted small">${(r.collections || []).join(', ')}</div>
          </div>
          <div class="pill">${r.count ?? 0}</div>
        </div>`
      ).join('') || '<div class="muted">No repos found</div>'
    );
  } catch {
    $('repoList') && ($('repoList').innerHTML = '<div class="muted">Failed to load</div>');
  }

  try {
    const docs = await api(`${API}/docs`);
    const items = docs.items ?? [];
    $('docList') && ($('docList').innerHTML =
      items.map(d=>`
        <div class="row">
          <div class="w-clip" title="${d.source || ''}">${d.source || '(no source)'}</div>
          <div class="pill">${d.count ?? 0}</div>
        </div>`
      ).join('') || '<div class="muted">No documents found</div>'
    );
  } catch {
    $('docList') && ($('docList').innerHTML = '<div class="muted">Failed to load</div>');
  }
}

async function loadTags(){
  const filter = ($('tagSearch')?.value || '').toLowerCase().trim();
  try {
    const t = await api(`${API}/tags`);
    let items = t.items ?? [];
    if (filter) items = items.filter(i => (i.tag||'').toLowerCase().includes(filter));
    $('tagList') && ($('tagList').innerHTML =
      items.map(i=>`
        <div class="row">
          <div><strong>${i.tag}</strong> <span class="muted small">(${i.conversations ?? 0} convs)</span></div>
          <div class="pill">${i.count ?? 0}</div>
        </div>`
      ).join('') || '<div class="muted">No tags found</div>'
    );
  } catch {
    $('tagList') && ($('tagList').innerHTML = '<div class="muted">Failed to load tags</div>');
  }
}
$('tagSearch')?.addEventListener('input', loadTags);

async function loadConvos(){
  const tags = ($('convFilterTags')?.value || '')
      .split(',').map(s=>s.trim()).filter(Boolean);
  const profile = $('convFilterProfile')?.value || undefined;

  try {
    const qs = new URLSearchParams();
    if (profile) qs.set('profile', profile);
    if (tags.length) qs.set('tags', tags.join(','));

    const data = await api(`${API}/conversations?${qs.toString()}`);
    const items = data.items ?? [];
    $('convList') && ($('convList').innerHTML =
      items.map(c=>`
        <div class="row">
          <div>
            <strong>${c.conversation_id}</strong>
            <div class="small muted">${c.last_timestamp ? new Date(c.last_timestamp).toLocaleString() : ''}</div>
            <div class="small">${(c.tags || []).map(t=>`<span class="pill">${t}</span>`).join(' ')}</div>
          </div>
          <div class="pill">${c.chunks ?? 0} chunks</div>
        </div>`
      ).join('') || '<div class="muted">No conversations found</div>'
    );
  } catch {
    $('convList') && ($('convList').innerHTML = '<div class="muted">Failed to load</div>');
  }
}
$('btnLoadConvos')?.addEventListener('click', loadConvos);

async function runPlayground(){
  const q = $('q')?.value.trim();
  if (!q) return;
  const body = {
    question: q,
    search_code: $('pCode')?.checked ?? true,
    search_docs: $('pDocs')?.checked ?? true
  };
  $('playResults') && ($('playResults').innerHTML = '<div class="muted">Running…</div>');
  try {
    // Playground goes through normal /query (top-level)
    const r = await api('/query', {
      method:'POST',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify(body)
    });
    const sources = (r.sources || []).map(s=>`
      <div class="hit">
        <div>
          <strong>${s.type==='code' ? (s.file || '') : (s.source || '')}</strong>
          <span class="score">${(Number(s.score||0)*100).toFixed(0)}%</span>
        </div>
      </div>`).join('');
    const safe = (r.answer||'').replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
    $('playResults') && ($('playResults').innerHTML = `
      <h4>Answer</h4>
      <div class="hit"><pre class="small" style="white-space:pre-wrap">${safe}</pre></div>
      <h4>Sources</h4>
      ${sources || '<div class="muted">No sources</div>'}
    `);
  } catch {
    $('playResults') && ($('playResults').innerHTML = '<div class="muted">Query failed</div>');
  }
}
$('btnRun')?.addEventListener('click', runPlayground);

$('btnClearCache')?.addEventListener('click', async ()=>{
  try {
    await api(`${API}/cache/clear`, { method:'POST' });
    alert('Redis caches cleared');
  } catch {
    alert('Failed to clear cache');
  }
});

// initial loads after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadSources();
  loadTags();
});
