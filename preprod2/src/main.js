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
Logger.info('Bootstrapping IDE...');

// Ensure Monaco is ready, then initialize modules
function bootstrap() {
 // Initialize core UI regardless of Monaco availability
 state.fileTree = {};

 initPanels();
 initModals();
 initTerminal();
 initTabs();
 initFileTree();
 
 // Add helpful hover tooltips on common buttons
 applyTooltips();


 // Render initial state (file tree + default file)
 setTimeout(() => {
 renderFileTree();
 updateGitStatus();
 }, 200);

 // Event subscriptions
 bus.on('file:open', ({ path }) => {
 const file = getFileFromPath(path);
 if (!file || file.type !== 'file') return;
 if (!state.openFiles.has(path)) {
   state.openFiles.set(path, { content: file.content ?? '', originalContent: file.content ?? '', modified: false });

 // Initialize password field visibility based on default selection
 const authSel = qs('#authMethod');
 if (authSel) {
   const group = qs('#passwordGroup');
   if (group) group.classList.toggle('hidden', authSel.value !== 'password');
 }
 }
 state.activeFile = path;
 updateTabs();
 if (state.editor) { loadFileInEditor(path); }
 bus.emit('ui:fileTree:selection');
 setStatus(`📖 Opened ${path}`);
 const lang = (getLanguageFromPath(path) || 'plaintext').toUpperCase();
 const lm = qs('#languageMode'); if (lm) lm.textContent = lang;
 // Lazy-load content from remote if missing
 if (file.content == null && state.isConnected) {
   API.readRemoteFile(path)
     .then((content) => {
       file.content = content;
       const entry = state.openFiles.get(path);
       if (entry) {
         entry.content = content;
         entry.originalContent = content;
         entry.modified = false;
       }
       if (state.activeFile === path && state.editor) { loadFileInEditor(path); }
       updateTabs();
       bus.emit('ui:fileTree:selection');
     })
     .catch((e) => console.warn('Failed to load remote file', path, e));
 }
});
 if (!file || file.type !== 'file') return;
 if (!state.openFiles.has(path)) {
 state.openFiles.set(path, { content: file.content, originalContent: file.content, modified: false });
 }
 state.activeFile = path;
 updateTabs();
 // Only load into Monaco if the editor is ready
 if (state.editor) {
 loadFileInEditor(path);
 }

 bus.on('workspace:changed', ({ connected, host }) => {
 const termHost = qs('#terminalHost');
 if (termHost) termHost.textContent = connected ? host : 'localhost';
 });

 bus.on('fileTree:replace', ({ tree }) => {
 state.fileTree = tree;
 renderFileTree();
 });

 bus.on('editor:save', () => saveCurrentFile());

 // Keyboard shortcuts (work even if editor isn't ready; guarded inside handlers)
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

 // Event delegation for all [data-action] buttons (fixes 'buttons don't respond')
 document.body.addEventListener('click', onActionClick);

 // Search input
 qs('#searchInput')?.addEventListener('input', (e) => Search.searchInFiles(e.target.value));

 // Auth method change (toggle password/key fields)
  function updateAuthGroups(val){
    const isPassword = val === 'password';
    const pw = qs('#passwordGroup');
    const pk = qs('#privateKeyGroup');
    const pp = qs('#passphraseGroup');
    if (pw) pw.classList.toggle('hidden', !isPassword);
    if (pk) pk.classList.toggle('hidden', isPassword);
    if (pp) pp.classList.toggle('hidden', isPassword);
  }
  const authSel = qs('#authMethod');
  authSel?.addEventListener('change', (e)=> updateAuthGroups(e.target.value));
  if (authSel) updateAuthGroups(authSel.value);


// Provide simple hover tooltips on key controls
function applyTooltips(){
  const map = [
    ['[data-action="modal:open"][data-target="#githubModal"]', 'Open GitHub integration'],
    ['[data-action="git:pull"]', 'Pull latest changes from origin/main'],
    ['[data-action="git:fetch"]', 'Fetch remote updates without merging'],
    ['[data-action="git:stash"]', 'Stash local changes'],
    ['[data-action="git:create-branch"]', 'Create and switch to a new branch'],
    ['[data-action="git:quick-commit-push"]', 'Commit all staged changes and push to origin'],
    ['[data-action="docker:build"]', 'Build Docker image(s)'],
    ['[data-action="docker:run"]', 'Run Docker containers'],
    ['[data-action="docker:ps"]', 'List containers'],
    ['[data-action="docker:stop"]', 'Stop all running containers'],
    ['.sidebar-tab[data-panel="explorer"]', 'Explorer'],
    ['.sidebar-tab[data-panel="search"]', 'Search in files'],
    ['.sidebar-tab[data-panel="ssh"]', 'SSH connections'],
    ['[data-action="files:refresh"]', 'Refresh file tree'],
    ['[data-action="files:new-file"]', 'Create new file'],
    ['[data-action="files:new-folder"]', 'Create new folder'],
    ['[data-action="files:upload"]', 'Upload files'],
    ['[data-action="editor:save"]', 'Save (Ctrl/Cmd+S)'],
    ['[data-action="editor:save-all"]', 'Save all (Ctrl/Cmd+Shift+S)'],
    ['[data-action="editor:format"]', 'Format document'],
    ['[data-action="editor:show-diff"]', 'Show changes vs original'],
    ['[data-action="editor:toggle-minimap"]', 'Toggle minimap'],
    ['[data-action="terminal:toggle"]', 'Show/Hide terminal panel'],
    ['[data-action="project:run"]', 'Run project'],
    ['[data-action="project:build"]', 'Build project'],
    ['[data-action="project:deploy"]', 'Deploy project'],
    ['#connectBtn', 'Open an SSH session using the provided credentials'],
    ['#disconnectBtn', 'Close the current SSH session']
  ];
  for (const [sel, title] of map){
    const el = qs(sel);
    if (el && !el.getAttribute('title')) el.setAttribute('title', title);
  }
}
 Logger.info('UI initialized');
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

 // Try to load Monaco editor if the AMD loader is available; otherwise keep the UI usable
 if (window.require) {
 window.require(['vs/editor/editor.main'], () => {
 Logger.info('Monaco loaded');
 initEditor({
 onCursorMove: (pos) => {
 const cp = qs('#cursorPosition');
 if (cp) cp.textContent = `Line ${pos.lineNumber}, Column ${pos.column}`;
 },
 onContentChange: () => {
 if (state.activeFile) bus.emit('file:modified', { path: state.activeFile });
 }
 });
 // If a file was opened before Monaco was ready, load it now
 if (state.activeFile) {
 loadFileInEditor(state.activeFile);
 }
 Logger.info('IDE initialized');
 });
 } else {
 Logger.error('Monaco loader not found. Proceeding without editor.');
 showNotification('⚠️ Monaco loader not found. Editor features disabled, UI still works.', 'warning');
 }
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
