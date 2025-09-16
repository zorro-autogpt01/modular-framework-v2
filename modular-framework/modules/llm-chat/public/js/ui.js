export const getEl = (id)=> document.getElementById(id);

export function setBusy(b) {
  const dot = getEl('dot'); const st = getEl('statusText');
  if (!dot || !st) return;
  if (b) { dot.classList.add('on'); st.textContent = 'Streaming…'; }
  else   { dot.classList.remove('on'); st.textContent = 'Idle'; }
}

export function addMsg(role, content) {
  const msgs = getEl('msgs'); if (!msgs) return;
  const el = document.createElement('div');
  el.className = `msg ${role==='user'?'user':'assistant'}`;
  el.textContent = content;
  msgs.appendChild(el); msgs.scrollTop = msgs.scrollHeight;
}

export function toast(msg){ alert(msg); }

/** Detects the base path of the module (handles /, /modules/llm-chat/, and /modules/llm-chat/config) */
export function detectBasePath() {
  const p = window.location.pathname;
  // strip trailing 'config' if present, ensure trailing slash
  const base = p.replace(/\/config\/?$/, '/');
  return base.endsWith('/') ? base : (base + '/');
}

export function showTab(tab){
  const map = { global:'tGlobal', profiles:'tProfiles' };
  Object.entries(map).forEach(([id, tabId])=>{
    const tabEl = getEl(tabId); const pane = getEl(id);
    if (!tabEl || !pane) return;
    tabEl.classList.toggle('active', tab===id);
    pane.style.display = tab===id ? '' : 'none';
  });
}
