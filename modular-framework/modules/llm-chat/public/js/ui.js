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
  el.dataset.msg = content;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  try { attachCopyButton(el, () => el.dataset.msg || el.textContent || ''); } catch {}
}


function _getMsgText(el) {
  return (el?.dataset?.msg ?? '').toString() || (el?.textContent ?? '').toString();
}

async function _writeClipboard(text) {
  const t = String(text ?? '');
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch (err) {
    try {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.setAttribute('readonly', '');
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      return true;
    } catch (e) {
      console.error('Copy to clipboard failed', e);
      return false;
    }
  }
}

export function attachCopyButton(msgEl, textProvider) {
  try {
    if (!msgEl || !(msgEl instanceof HTMLElement)) return;
    if (msgEl.querySelector('.copy-bubble-btn')) return; // already attached
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-bubble-btn';
    btn.title = 'Copy to clipboard';
    btn.setAttribute('aria-label', 'Copy message to clipboard');
    btn.textContent = '📋';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = typeof textProvider === 'function' ? textProvider() : _getMsgText(msgEl);
      const ok = await _writeClipboard(text);
      const prev = btn.textContent;
      btn.textContent = ok ? '✅' : '⚠️';
      setTimeout(() => { btn.textContent = prev || '📋'; }, 1200);
    });
    msgEl.appendChild(btn);
  } catch (e) {
    console.error('attachCopyButton failed', e);
  }
}
export function toast(msg){ alert(msg); }

/** Detects the base path of the module (handles /, /modules/llm-chat/, and /modules/llm-chat/config) */
export function detectBasePath() {
  const p = window.location.pathname;
  const base = p.replace(/\/config\/?$/, '/');
  return base.endsWith('/') ? base : (base + '/');
}

/** Sub-tab helper for Settings (switches between 'global' and 'profiles') */
export function showTab(tab){
  const map = { global:'tGlobal', profiles:'tProfiles' };
  Object.entries(map).forEach(([id, tabId])=>{
    const tabEl = getEl(tabId); const pane = getEl(id);
    if (!tabEl || !pane) return;
    tabEl.classList.toggle('active', tab===id);
    pane.style.display = tab===id ? '' : 'none';
  });
}
