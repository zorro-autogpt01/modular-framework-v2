// src/ui/folderPicker.js
import { state } from '../core/state.js';
import { fetchRemoteTree } from '../services/api.js';
import { showNotification } from './notifications.js';

/**
 * Show a modal to pick a directory. Works best when SSH is connected.
 * If not connected, falls back to manual path input.
 *
 * @param {Object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.initialPath]
 * @returns {Promise<string|null>} selected absolute path or null if cancelled
 */
export function showFolderPicker({ title = 'Select Folder', initialPath = null } = {}) {
  return new Promise(async (resolve) => {
    const modal = document.getElementById('folderPickerModal');
    const titleEl = document.getElementById('fpTitle');
    const inputEl = document.getElementById('fpPathInput');
    const listEl = document.getElementById('fpList');
    const upBtn = document.getElementById('fpUpBtn');
    const chooseBtn = document.getElementById('fpChooseBtn');
    const cancelBtn = document.getElementById('fpCancelBtn');
    const statusEl = document.getElementById('fpStatus');

    if (!modal || !titleEl || !inputEl || !listEl || !upBtn || !chooseBtn || !cancelBtn || !statusEl) {
      console.error('[FolderPicker] Modal elements missing in DOM');
      showNotification('❌ Folder picker not available in this build', 'error');
      return resolve(null);
    }

    titleEl.textContent = title;
    const startPath = initialPath || state.remoteRoot || '/';
    let currentPath = startPath;

    function parentDir(p) {
      if (!p || p === '/') return '/';
      const clean = p.replace(/\/+$/, '');
      const idx = clean.lastIndexOf('/');
      if (idx <= 0) return '/';
      return clean.slice(0, idx) || '/';
    }

    function setBusy(busy, msg = '') {
      statusEl.textContent = msg;
      statusEl.style.visibility = busy ? 'visible' : (msg ? 'visible' : 'hidden');
    }

    async function loadDir(path) {
      inputEl.value = path;
      listEl.innerHTML = '<div class="muted">Loading…</div>';
      setBusy(true, 'Loading folders...');

      try {
        const tree = state.isConnected ? await fetchRemoteTree(path, 1) : {};
        // Filter only folders
        const names = Object.keys(tree || {})
          .filter((k) => tree[k]?.type === 'folder')
          .sort((a, b) => a.localeCompare(b));

        listEl.innerHTML = '';
        if (!names.length) {
          listEl.innerHTML = '<div class="muted">No subfolders</div>';
        } else {
          for (const name of names) {
            const row = document.createElement('div');
            row.className = 'fp-row';
            row.innerHTML = `<span>📁</span><span class="fp-name">${name}</span>`;
            row.addEventListener('click', () => {
              // Single click selects
              const full = path === '/' ? `/${name}` : `${path.replace(/\/$/,'')}/${name}`;
              inputEl.value = full;
            });
            row.addEventListener('dblclick', async () => {
              // Double click navigates into
              const full = path === '/' ? `/${name}` : `${path.replace(/\/$/,'')}/${name}`;
              currentPath = full;
              await loadDir(currentPath);
            });
            listEl.appendChild(row);
          }
        }
        setBusy(false, '');
      } catch (e) {
        console.warn('[FolderPicker] list failed:', e);
        listEl.innerHTML = '<div class="muted">Failed to load folders</div>';
        setBusy(false, 'Failed to load. You can type a path manually.');
      }
    }

    // Wire buttons
    upBtn.onclick = async () => {
      const p = parentDir(currentPath);
      currentPath = p;
      await loadDir(currentPath);
    };
    chooseBtn.onclick = () => {
      const val = (inputEl.value || '').trim();
      if (!val) {
        showNotification('⚠️ Please select or enter a folder path', 'warning');
        return;
      }
      modal.classList.add('hidden');
      resolve(val);
    };
    cancelBtn.onclick = () => {
      modal.classList.add('hidden');
      resolve(null);
    };

    // Initial render
    modal.classList.remove('hidden');
    if (state.isConnected) {
      await loadDir(currentPath);
    } else {
      // Not connected: text input only
      inputEl.value = '.';
      listEl.innerHTML = '<div class="muted">Not connected. Enter a local path manually.</div>';
      setBusy(false, '');
    }
  });
}
