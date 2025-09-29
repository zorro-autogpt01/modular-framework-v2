// modular-framework/modules/llm-chat/public/js/ui.js

export const getEl = (id)=> document.getElementById(id);

export function setBusy(b) {
  const dot = getEl('dot'); const st = getEl('statusText');
  if (!dot || !st) return;
  if (b) { dot.classList.add('on'); st.textContent = 'Streaming…'; }
  else   { dot.classList.remove('on'); st.textContent = 'Idle'; }
}

// Create navigation sidebar once on page load
export function createNavigationSidebar() {
  // Check if sidebar already exists
  if (document.querySelector('.nav-sidebar')) return;
  
  const sidebar = document.createElement('div');
  sidebar.className = 'nav-sidebar';
  sidebar.innerHTML = `
    <button class="nav-btn" id="navTop" title="Jump to first">⬆️⬆️</button>
    <button class="nav-btn" id="navUp" title="Previous message">⬆️</button>
    <div class="nav-divider"></div>
    <button class="nav-btn" id="navDown" title="Next message">⬇️</button>
    <button class="nav-btn" id="navBottom" title="Jump to last">⬇️⬇️</button>
  `;
  
  // Find the appropriate container to append to
  const chatContainer = document.querySelector('.msgs-container') || 
                        document.querySelector('.chat') || 
                        document.body;
  chatContainer.appendChild(sidebar);
  
  // Attach event listeners
  getEl('navTop')?.addEventListener('click', () => navigateToMessage('first'));
  getEl('navUp')?.addEventListener('click', () => navigateToMessage('up'));
  getEl('navDown')?.addEventListener('click', () => navigateToMessage('down'));
  getEl('navBottom')?.addEventListener('click', () => navigateToMessage('last'));
}

function navigateToMessage(direction) {
  const msgs = document.querySelectorAll('.msg');
  if (!msgs.length) return;
  
  const msgsContainer = getEl('msgs');
  if (!msgsContainer) return;
  
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
  // Only attach copy button for completed messages
  requestAnimationFrame(() => {
    try { attachCopyButton(el); } catch {}
  });
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

// Simplified - only adds copy button
export function attachCopyButton(msgEl) {
  try {
    if (!msgEl || !(msgEl instanceof HTMLElement)) return;
    
    // Don't attach if still streaming or already has copy button
    if (msgEl.dataset.streaming === 'true') return;
    if (msgEl.querySelector('.msg-copy')) return;

    // Ensure the message is positioned
    try {
      const cs = window.getComputedStyle(msgEl);
      if (!cs || cs.position === 'static') {
        msgEl.style.position = 'relative';
      }
    } catch {}

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg-copy';
    copyBtn.title = 'Copy to clipboard';
    copyBtn.setAttribute('aria-label', 'Copy message');
    copyBtn.innerHTML = '📋';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const text = msgEl.dataset.msg || msgEl.textContent || '';
      const ok = await _writeClipboard(text);
      const prev = copyBtn.innerHTML;
      copyBtn.innerHTML = ok ? '✅' : '⚠️';
      copyBtn.classList.toggle('copied', ok);
      setTimeout(() => { 
        copyBtn.innerHTML = prev; 
        copyBtn.classList.remove('copied');
      }, 1200);
    });

    // Defer append to avoid layout issues
    requestAnimationFrame(() => {
      msgEl.appendChild(copyBtn);
    });
  } catch (e) {
    console.error('attachCopyButton failed', e);
  }
}

// Keep for backward compatibility
export function attachMessageControls(msgEl, textProvider) {
  return attachCopyButton(msgEl);
}

// Edit message functionality (if needed for user messages)
export function editMessage(msgEl) {
  const currentText = msgEl.dataset.msg || msgEl.textContent || '';
  
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
  
  const originalContent = msgEl.innerHTML;
  msgEl.innerHTML = '';
  msgEl.appendChild(textarea);
  
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
      requestAnimationFrame(() => {
        try { attachCopyButton(msgEl); } catch {}
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