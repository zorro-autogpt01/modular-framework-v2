import { Logger } from './core/logger.js';
import { bus } from './core/eventBus.js';
import { state } from './core/state.js';
import { qs, qsa } from './ui/dom.js';
import { showNotification } from './ui/notifications.js';
import { initPanels } from './ui/panels.js';
import { initFileTree, renderFileTree } from './ui/fileTree.js';
import { initTabs, updateTabs, closeFile, switchToFile } from './ui/tabs.js';
import { setStatus } from './ui/statusBar.js';
import { initModals } from './ui/modals.js';
import { initEditor, loadFileInEditor, showDiff, toggleMinimap, getEditorValue } from './editor/index.js';
import { initTerminal, addToTerminal, addToOutput, addToDockerLogs, toggleTerminalPanel } from './terminal/index.js';
import * as API from './services/api.js';
import * as Git from './services/git.js';
import * as Docker from './services/docker.js';
import * as DB from './services/db.js';
import * as SSH from './services/ssh.js';
import * as Search from './services/search.js';
import { getFileFromPath, getLanguageFromPath } from './utils/path.js';
import { localTree } from './data/sampleFileTree.js';

Logger.info('Bootstrapping IDE...');

// Ensure Monaco is ready, then initialize modules
function bootstrap() {
  if (!window.require) {
    Logger.error('Monaco loader not found.');
    showNotification('❌ Monaco loader not found', 'error');
    return;
  }
  window.require(['vs/editor/editor.main'], () => {
    Logger.info('Monaco loaded');
    state.fileTree = localTree;

    initPanels();
    initModals();
    initTerminal();

    initEditor({
      onCursorMove: (pos) => {
        qs('#cursorPosition').textContent = `Line ${pos.lineNumber}, Column ${pos.column}`;
      },
      onContentChange: () => {
        // Notify others about potential modifications
        if (state.activeFile) bus.emit('file:modified', { path: state.activeFile });
      }
    });

    initTabs();
    initFileTree();

    // Render initial state
    setTimeout(() => {
      renderFileTree();
      bus.emit('file:open', { path: 'README.md' });
      updateGitStatus();
    }, 200);

    // Event subscriptions
    bus.on('file:open', ({ path }) => {
      const file = getFileFromPath(path);
      if (!file || file.type !== 'file') return;
      if (!state.openFiles.has(path)) {
        state.openFiles.set(path, { content: file.content, originalContent: file.content, modified: false });
      }
      state.activeFile = path;
      updateTabs();
      loadFileInEditor(path);
      bus.emit('ui:fileTree:selection');
      setStatus(`📖 Opened ${path}`);
      qs('#languageMode').textContent = (getLanguageFromPath(path) || 'plaintext').toUpperCase();
    });

    bus.on('workspace:changed', ({ connected, host }) => {
      const termHost = qs('#terminalHost');
      if (termHost) termHost.textContent = connected ? host : 'localhost';
    });

    bus.on('fileTree:replace', ({ tree }) => {
      state.fileTree = tree;
      renderFileTree();
    });

    bus.on('editor:save', () => saveCurrentFile());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey) {
        switch (e.key) {
          case 's':
            e.preventDefault();
            if (e.shiftKey) saveAllFiles(); else saveCurrentFile();
            break;
          case 'n':
            e.preventDefault();
            newFile();
            break;
          case '`':
            e.preventDefault();
            toggleTerminalPanel();
            break;
        }
      }
    });

    // Event delegation
    document.body.addEventListener('click', onActionClick);

    // Search input
    qs('#searchInput')?.addEventListener('input', (e) => Search.searchInFiles(e.target.value));

    // Auth method change
    qs('#authMethod')?.addEventListener('change', (e) => {
      const v = e.target.value;
      const pass = qs('#passwordGroup');
      const keyg = qs('#keyGroup');
      pass?.classList.toggle('hidden', v !== 'password');
      keyg?.classList.toggle('hidden', v !== 'key');
    });


    Logger.info('IDE initialized');

    // Key upload → populate textarea, keep in memory only
    const keyFileInput = qs('#sshPrivateKeyFile');
    const keyTextArea = qs('#sshPrivateKey');
    keyFileInput?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      if (keyTextArea) keyTextArea.value = text;
    });

    console.log('Use window.AdvancedCodeEditorAPI for external control');

    // Expose limited external API
    window.AdvancedCodeEditorAPI = {
      openFile: (path, content) => {
        state.fileTree[path] = { type: 'file', content };
        renderFileTree();
        bus.emit('file:open', { path });
      },
      connectToRemote: (config) => API.connectSSH(config),
      getCurrentFile: () => state.activeFile,
      getCurrentContent: () => getEditorValue(),
      showNotification: (message, type) => showNotification(message, type),
      API
    };
  });
}

function onActionClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  switch (action) {
    // Panels / Modals
    case 'modal:open': {
      const t = btn.getAttribute('data-target');
      bus.emit('modal:open', { target: t });
      break;
    }
    case 'modal:close': {
      const t = btn.getAttribute('data-target');
      bus.emit('modal:close', { target: t });
      break;
    }
    // Git
    case 'git:pull': Git.pull().then(updateGitStatus); break;
    case 'git:fetch': Git.fetch().then(updateGitStatus); break;
    case 'git:stash': Git.stash().then(updateGitStatus); break;
    case 'git:create-branch': Git.createBranch(); break;
    case 'git:quick-commit-push': Git.quickCommitPush(qs('#commitMessage')?.value || '').then(updateGitStatus); break;
    // Docker
    case 'docker:build': Docker.build(); break;
    case 'docker:run': Docker.run(); break;
    case 'docker:ps': Docker.ps(); break;
    case 'docker:stop': Docker.stopAll(); break;
    // DB
    case 'database:open-add-modal': bus.emit('modal:open', { target: '#databaseModal' }); break;
    case 'database:test-connection': DB.testConnection(); break;
    case 'database:save-connection': DB.saveConnection(); break;
    case 'database:execute-query': DB.executeQuery(); break;
    case 'database:clear-query': DB.clearQuery(); break;
    case 'database:connect': DB.connect(btn.getAttribute('data-connection')); break;
    // SSH
    case 'ssh:connect': SSH.connect(); break;
    case 'ssh:disconnect': SSH.disconnect(); break;
    // Files
    case 'files:refresh': renderFileTree(); showNotification('📂 File tree refreshed', 'info'); break;
    case 'files:new-file': newFile(); break;
    case 'files:new-folder': newFolder(); break;
    case 'files:upload': uploadFile(); break;
    // Editor
    case 'editor:save': saveCurrentFile(); break;
    case 'editor:save-all': saveAllFiles(); break;
    case 'editor:format': formatDocument(); break;
    case 'editor:show-diff': showDiff(); break;
    case 'editor:toggle-minimap': toggleMinimap(); break;
    // Terminal
    case 'terminal:toggle': toggleTerminalPanel(); break;
    // Project
    case 'project:build': buildProject(); break;
    case 'project:run': runProject(); break;
    case 'project:deploy': deployProject(); break;
    // GitHub
    case 'github:execute': API.executeGitHubAction(); break;
  }
}

function updateGitStatus() {
  const el = qs('#gitInfo');
  if (el) el.textContent = `🌿 ${state.git.branch}`;
}

// File operations and helpers (UI-level)
function newFile() {
  const fileName = prompt('Enter file name:', 'newfile.js');
  if (!fileName) return;
  const content = `// New file: ${fileName}\n// Created: ${new Date().toISOString()}\n\n`;
  state.fileTree[fileName] = { type: 'file', content };
  state.openFiles.set(fileName, { content, originalContent: '', modified: true });
  state.activeFile = fileName;
  renderFileTree();
  updateTabs();
  loadFileInEditor(fileName);
  setStatus(`📄 Created ${fileName}`);
}

function newFolder() {
  const folderName = prompt('Enter folder name:', 'new-folder');
  if (!folderName) return;
  state.fileTree[folderName] = { type: 'folder', children: {} };
  renderFileTree();
  setStatus(`📁 Created folder ${folderName}`);
}

function uploadFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = (e) => {
    Array.from(e.target.files).forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        state.fileTree[file.name] = { type: 'file', content: ev.target.result };
        renderFileTree();
        showNotification(`⬆️ Uploaded ${file.name}`, 'success');
      };
      reader.readAsText(file);
    });
  };
  input.click();
}

function saveCurrentFile() {
  if (!state.activeFile || !state.editor) return;
  const content = getEditorValue();
  const fileData = state.openFiles.get(state.activeFile);
  if (!fileData) return;
  fileData.originalContent = content;
  fileData.modified = false;
  const f = getFileFromPath(state.activeFile);
  if (f) f.content = content;
  updateTabs();
  bus.emit('ui:fileTree:selection');
  setStatus(`💾 Saved ${state.activeFile}`);
  showNotification(`✅ File saved: ${state.activeFile.split('/').pop()}`, 'success');
}

function saveAllFiles() {
  let saved = 0;
  for (const [path, fileData] of state.openFiles) {
    if (fileData.modified) {
      fileData.originalContent = fileData.content;
      fileData.modified = false;
      const f = getFileFromPath(path);
      if (f) f.content = fileData.content;
      saved++;
    }
  }
  updateTabs();
  bus.emit('ui:fileTree:selection');
  showNotification(`✅ Saved ${saved} files`, 'success');
}

function formatDocument() {
  if (state.editor && state.activeFile) {
    state.editor.getAction('editor.action.formatDocument').run();
    setStatus('🎨 Document formatted');
  }
}

function buildProject() {
  bus.emit('panel:show', { name: 'output' });
  addToOutput(`🔨 Building project...`);
  setTimeout(() => addToOutput('✅ Build completed successfully!'), 1500);
}

function runProject() {
  bus.emit('panel:show', { name: 'output' });
  addToOutput(`▶️ Starting project...`);
  setTimeout(() => addToOutput('🚀 Server running on http://localhost:3000'), 1200);
}

function deployProject() {
  bus.emit('panel:show', { name: 'output' });
  addToOutput('🚀 Deploying project...');
  setTimeout(() => { addToOutput('✅ Deployment successful!'); showNotification('🚀 Project deployed!', 'success'); }, 1500);
}

// Start
bootstrap();
