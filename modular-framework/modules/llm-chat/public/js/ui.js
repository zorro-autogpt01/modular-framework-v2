// modular-framework/modules/llm-chat/public/js/ui.js

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
  el.dataset.complete = 'true';
  el.dataset.role = role;
  el.dataset.timestamp = new Date().toISOString();
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  // Only attach controls for completed messages; defer a frame to avoid layout race
  requestAnimationFrame(() => {
    try { attachMessageControls(el, () => el.dataset.msg || el.textContent || ''); } catch {}
  });
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

function navigateToMessage(direction) {
  const msgs = document.querySelectorAll('.msg');
  if (!msgs.length) return;
  
  const msgsContainer = getEl('msgs');
  const containerRect = msgsContainer.getBoundingClientRect();
  const currentScrollTop = msgsContainer.scrollTop;
  
  if (direction === 'first') {
    msgs[0].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (direction === 'last') {
    msgs[msgs.length - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  
  // Find the current visible message
  let currentIndex = -1;
  for (let i = 0; i < msgs.length; i++) {
    const rect = msgs[i].getBoundingClientRect();
    const relativeTop = rect.top - containerRect.top;
    if (relativeTop >= -10 && relativeTop <= containerRect.height / 2) {
      currentIndex = i;
      break;
    }
  }
  
  // If no current message found, use scroll position
  if (currentIndex === -1) {
    for (let i = 0; i < msgs.length; i++) {
      const msgTop = msgs[i].offsetTop - msgsContainer.offsetTop;
      if (msgTop >= currentScrollTop) {
        currentIndex = i;
        break;
      }
    }
  }
  
  if (currentIndex === -1) currentIndex = msgs.length - 1;
  
  let targetIndex;
  if (direction === 'up') {
    targetIndex = Math.max(0, currentIndex - 1);
  } else if (direction === 'down') {
    targetIndex = Math.min(msgs.length - 1, currentIndex + 1);
  }
  
  if (targetIndex !== undefined && msgs[targetIndex]) {
    msgs[targetIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function editMessage(msgEl) {
  const currentText = msgEl.dataset.msg || msgEl.textContent || '';
  
  // Create textarea for editing
  const textarea = document.createElement('textarea');
  textarea.className = 'msg-edit';
  textarea.value = currentText;
  textarea.style.cssText = `
    width: 100%;
    min-height: 100px;
    padding: 10px;
    border: 1px solid var(--accent);
    background: var(--bg);
    color: var(--txt);
    border-radius: 8px;
    font: inherit;
    resize: vertical;
  `;
  
  // Hide original text
  const originalContent = msgEl.innerHTML;
  msgEl.innerHTML = '';
  msgEl.appendChild(textarea);
  
  // Create save/cancel buttons
  const editControls = document.createElement('div');
  editControls.style.cssText = 'margin-top: 8px; display: flex; gap: 8px;';
  
  const saveBtn = document.createElement('button');
  saveBtn.textContent = '✅ Save';
  saveBtn.className = 'btn';
  saveBtn.onclick = () => {
    const newText = textarea.value.trim();
    if (newText) {
      msgEl.textContent = newText;
      msgEl.dataset.msg = newText;
      msgEl.dataset.edited = 'true';
      // Re-attach controls on next frame
      requestAnimationFrame(() => {
        try { attachMessageControls(msgEl, () => newText); } catch {}
      });
    }
  };
  
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '❌ Cancel';
  cancelBtn.className = 'ghost';
  cancelBtn.onclick = () => {
    msgEl.innerHTML = originalContent;
  };
  
  editControls.appendChild(saveBtn);
  editControls.appendChild(cancelBtn);
  msgEl.appendChild(editControls);
  
  textarea.focus();
  textarea.select();
}

export function attachMessageControls(msgEl, textProvider) {
  try {
    if (!msgEl || !(msgEl instanceof HTMLElement)) return;
    
    // Don't attach if still streaming or already has controls
    if (msgEl.dataset.streaming === 'true') return;
    if (msgEl.querySelector('.msg-controls')) return;

    // ✅ Defensive: ensure the message container is a positioned ancestor
    try {
      const cs = window.getComputedStyle(msgEl);
      if (!cs || cs.position === 'static') {
        msgEl.style.position = 'relative';
      }
    } catch {}

    const controls = document.createElement('div');
    controls.className = 'msg-controls';
    
    // Copy button
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-btn';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = '📋';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = typeof textProvider === 'function' ? textProvider() : _getMsgText(msgEl);
      const ok = await _writeClipboard(text);
      const prev = copyBtn.innerHTML;
      copyBtn.innerHTML = ok ? '✅' : '⚠️';
      copyBtn.classList.toggle('copied', ok);
      setTimeout(() => { 
        copyBtn.innerHTML = prev; 
        copyBtn.classList.remove('copied');
      }, 1200);
    });
    
    // Edit button only for user bubbles
    const isUser = msgEl.classList.contains('user');
    if (isUser) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'msg-btn';
      editBtn.title = 'Edit message';
      editBtn.setAttribute('aria-label', 'Edit message');
      editBtn.innerHTML = '✏️';
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        editMessage(msgEl);
      });
      controls.appendChild(editBtn);
    }
    
    // Navigation controls
    const topBtn = document.createElement('button');
    topBtn.type = 'button';
    topBtn.className = 'msg-btn';
    topBtn.title = 'Jump to first';
    topBtn.setAttribute('aria-label', 'Jump to first message');
    topBtn.innerHTML = '⏫';
    topBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateToMessage('first');
    });
    
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'msg-btn';
    upBtn.title = 'Previous';
    upBtn.setAttribute('aria-label', 'Previous message');
    upBtn.innerHTML = '⬆️';
    upBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateToMessage('up');
    });
    
    const downBtn = document.createElement('button');
    downBtn.type = 'button';
    downBtn.className = 'msg-btn';
    downBtn.title = 'Next';
    downBtn.setAttribute('aria-label', 'Next message');
    downBtn.innerHTML = '⬇️';
    downBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateToMessage('down');
    });
    
    const bottomBtn = document.createElement('button');
    bottomBtn.type = 'button';
    bottomBtn.className = 'msg-btn';
    bottomBtn.title = 'Jump to last';
    bottomBtn.setAttribute('aria-label', 'Jump to last message');
    bottomBtn.innerHTML = '⏬';
    bottomBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateToMessage('last');
    });
    
    // Timestamp indicator (read-only)
    const timestamp = msgEl.dataset.timestamp;
    if (timestamp) {
      const timeBtn = document.createElement('span');
      timeBtn.className = 'msg-btn';
      timeBtn.style.cssText = 'cursor: default; font-size: 10px; padding: 2px 4px;';
      const date = new Date(timestamp);
      const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      timeBtn.textContent = timeStr;
      timeBtn.title = date.toLocaleString();
      controls.appendChild(timeBtn);
    }
    
    controls.appendChild(copyBtn);
    controls.appendChild(topBtn);
    controls.appendChild(upBtn);
    controls.appendChild(downBtn);
    controls.appendChild(bottomBtn);

    // Defer append to avoid top-left flashes before layout stabilizes
    requestAnimationFrame(() => {
      msgEl.appendChild(controls);
    });
  } catch (e) {
    console.error('attachMessageControls failed', e);
  }
}

// Export the old function name for backward compatibility
export function attachCopyButton(msgEl, textProvider) {
  return attachMessageControls(msgEl, textProvider);
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
