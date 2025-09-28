// src/editor/multiEditor.js
import { state } from '../core/state.js';
import { bus } from '../core/eventBus.js';
import { Logger } from '../core/logger.js';
import { getLanguageFromPath } from '../utils/path.js';

// Track three separate editor instances
const editors = {
  editor1: null,
  editor2: null,
  editor3: null,
  diffEditor: null
};

// Track which editor is currently focused
let focusedEditor = 'editor1';

// Track file-to-editor mapping
const editorFiles = {
  editor1: null,
  editor2: null,
  editor3: null
};

export function initTripleEditors({ onCursorMove, onContentChange }) {
  // Initialize three separate editor instances
  editors.editor1 = monaco.editor.create(document.getElementById('monaco-editor-1'), {
    value: '',
    language: 'markdown',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    fontSize: 14,
    lineNumbers: 'on',
    wordWrap: 'on',
    cursorBlinking: 'blink',
    quickSuggestions: true,
    suggestOnTriggerCharacters: true,
    formatOnPaste: true,
    formatOnType: true
  });
  
  editors.editor2 = monaco.editor.create(document.getElementById('monaco-editor-2'), {
    value: '',
    language: 'markdown',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 14,
    lineNumbers: 'on',
    wordWrap: 'on'
  });
  
  editors.editor3 = monaco.editor.create(document.getElementById('monaco-editor-3'), {
    value: '',
    language: 'markdown',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 14,
    lineNumbers: 'on',
    wordWrap: 'on'
  });
  
  // Diff editor in the third pane (can be toggled)
  editors.diffEditor = monaco.editor.createDiffEditor(document.getElementById('monaco-diff'), {
    theme: 'vs-dark',
    automaticLayout: true,
    readOnly: false
  });
  
  // Set up event handlers for each editor
  setupEditorHandlers('editor1', editors.editor1, onCursorMove, onContentChange);
  setupEditorHandlers('editor2', editors.editor2, onCursorMove, onContentChange);
  setupEditorHandlers('editor3', editors.editor3, onCursorMove, onContentChange);
  
  // Handle focus switching
  editors.editor1.onDidFocusEditorText(() => {
    focusedEditor = 'editor1';
    updateEditorHeaders();
  });
  
  editors.editor2.onDidFocusEditorText(() => {
    focusedEditor = 'editor2';
    updateEditorHeaders();
  });
  
  editors.editor3.onDidFocusEditorText(() => {
    focusedEditor = 'editor3';
    updateEditorHeaders();
  });
  
  // Subscribe to file open events
  bus.on('file:open', ({ path }) => {
    openFileInNextEditor(path);
  });
  
  // Subscribe to tab updates
  bus.on('ui:tabs:update', () => {
    updateEditorHeaders();
  });
  
  // Make editors available globally for the main module
  state.editor = editors.editor1; // Default editor for backward compatibility
  state.editors = editors;
  state.editorFiles = editorFiles;
}

function setupEditorHandlers(editorId, editor, onCursorMove, onContentChange) {
  editor.onDidChangeCursorPosition((e) => {
    if (focusedEditor === editorId) {
      onCursorMove?.(e.position);
    }
  });
  
  editor.onDidChangeModelContent(() => {
    const filePath = editorFiles[editorId];
    if (filePath) {
      const fileData = state.openFiles.get(filePath);
      if (!fileData) return;
      
      const current = editor.getValue();
      fileData.content = current;
      fileData.modified = current !== fileData.originalContent;
      
      bus.emit('ui:tabs:update');
      bus.emit('ui:fileTree:selection');
      onContentChange?.();
    }
  });
}

export function openFileInEditor(filePath, targetEditor = null) {
  const fileData = state.openFiles.get(filePath);
  if (!fileData) {
    Logger.warn('File not in openFiles:', filePath);
    return;
  }
  
  // Determine which editor to use
  let editorId = targetEditor;
  if (!editorId) {
    // Find the next available editor or use focused one
    if (!editorFiles.editor1) {
      editorId = 'editor1';
    } else if (!editorFiles.editor2) {
      editorId = 'editor2';
    } else if (!editorFiles.editor3) {
      editorId = 'editor3';
    } else {
      // All editors have files, use the focused one
      editorId = focusedEditor;
    }
  }
  
  const editor = editors[editorId];
  if (!editor) return;
  
  const language = getLanguageFromPath(filePath);
  
  // Hide diff editor if showing in editor3
  if (editorId === 'editor3') {
    const diffEl = document.getElementById('monaco-diff');
    const editor3El = document.getElementById('monaco-editor-3');
    if (diffEl) diffEl.classList.add('hidden');
    if (editor3El) editor3El.classList.remove('hidden');
  }
  
  // Create or reuse a model for this file
  let model = fileData.model;
  if (!model || model.isDisposed?.()) {
    const uri = monaco.Uri.parse(`inmemory://${editorId}/${filePath}`);
    model = monaco.editor.createModel(fileData.content ?? '', language, uri);
    fileData.model = model;
  } else {
    monaco.editor.setModelLanguage(model, language);
    if (model.getValue() !== fileData.content) {
      model.setValue(fileData.content);
    }
  }
  
  editor.setModel(model);
  
  // Update tracking
  editorFiles[editorId] = filePath;
  
  // Update active file for the focused editor
  if (editorId === focusedEditor) {
    state.activeFile = filePath;
  }
  
  updateEditorHeaders();
}

export function openFileInNextEditor(filePath) {
  // Rotate through editors for multiple file opening
  if (!editorFiles.editor1 || focusedEditor === 'editor1') {
    openFileInEditor(filePath, 'editor1');
  } else if (!editorFiles.editor2 || focusedEditor === 'editor2') {
    openFileInEditor(filePath, 'editor2');
  } else if (!editorFiles.editor3 || focusedEditor === 'editor3') {
    openFileInEditor(filePath, 'editor3');
  } else {
    // All editors occupied, replace in focused editor
    openFileInEditor(filePath, focusedEditor);
  }
}

export function showDiffInEditor3(originalContent, modifiedContent, filePath) {
  const diffEl = document.getElementById('monaco-diff');
  const editor3El = document.getElementById('monaco-editor-3');
  
  if (!diffEl || !editor3El) return;
  
  // Show diff, hide regular editor3
  editor3El.classList.add('hidden');
  diffEl.classList.remove('hidden');
  
  const lang = getLanguageFromPath(filePath);
  
  // Dispose previous diff models
  if (state.diffModels) {
    try { state.diffModels.original.dispose(); } catch {}
    try { state.diffModels.modified.dispose(); } catch {}
    state.diffModels = null;
  }
  
  const originalModel = monaco.editor.createModel(
    originalContent ?? '',
    lang,
    monaco.Uri.parse(`inmemory://diff/original/${filePath}`)
  );
  
  const modifiedModel = monaco.editor.createModel(
    modifiedContent ?? '',
    lang,
    monaco.Uri.parse(`inmemory://diff/modified/${filePath}`)
  );
  
  editors.diffEditor.setModel({
    original: originalModel,
    modified: modifiedModel
  });
  
  state.diffModels = { original: originalModel, modified: modifiedModel };
  
  // Update header
  const header = document.getElementById('editor3Title');
  if (header) {
    header.textContent = `Diff: ${filePath.split('/').pop()}`;
  }
}

export function focusEditor(editorId) {
  const editor = editors[editorId];
  if (!editor) return;
  
  editor.focus();
  focusedEditor = editorId;
  
  // Update active file
  const filePath = editorFiles[editorId];
  if (filePath) {
    state.activeFile = filePath;
    bus.emit('ui:tabs:update');
    bus.emit('ui:fileTree:selection');
  }
  
  updateEditorHeaders();
}

export function toggleMinimap(editorId = null) {
  const targetEditor = editorId ? editors[editorId] : editors[focusedEditor];
  if (!targetEditor) return;
  
  const minimap = targetEditor.getOption(monaco.editor.EditorOption.minimap);
  targetEditor.updateOptions({ minimap: { enabled: !minimap.enabled } });
}

export function getEditorValue(editorId = null) {
  const targetEditor = editorId ? editors[editorId] : editors[focusedEditor];
  return targetEditor ? targetEditor.getValue() : '';
}

export function getCurrentEditorFile(editorId = null) {
  const targetId = editorId || focusedEditor;
  return editorFiles[targetId];
}

function updateEditorHeaders() {
  // Update editor 1 header
  const header1 = document.getElementById('editor1Title');
  if (header1) {
    const file1 = editorFiles.editor1;
    if (file1) {
      const name = file1.split('/').pop();
      const modified = state.openFiles.get(file1)?.modified ? ' ●' : '';
      header1.textContent = `${name}${modified}`;
    } else {
      header1.textContent = 'Editor 1';
    }
  }
  
  // Update editor 2 header
  const header2 = document.getElementById('editor2Title');
  if (header2) {
    const file2 = editorFiles.editor2;
    if (file2) {
      const name = file2.split('/').pop();
      const modified = state.openFiles.get(file2)?.modified ? ' ●' : '';
      header2.textContent = `${name}${modified}`;
    } else {
      header2.textContent = 'Editor 2';
    }
  }
  
  // Update editor 3 header (unless showing diff)
  const header3 = document.getElementById('editor3Title');
  if (header3) {
    const diffEl = document.getElementById('monaco-diff');
    if (diffEl && !diffEl.classList.contains('hidden')) {
      // Diff is showing, keep diff title
      return;
    }
    
    const file3 = editorFiles.editor3;
    if (file3) {
      const name = file3.split('/').pop();
      const modified = state.openFiles.get(file3)?.modified ? ' ●' : '';
      header3.textContent = `${name}${modified}`;
    } else {
      header3.textContent = 'Editor 3';
    }
  }
  
  // Highlight focused editor
  document.querySelectorAll('.editor-pane').forEach(pane => {
    pane.classList.remove('focused');
  });
  
  const focusedPane = document.querySelector(`#monaco-${focusedEditor}`)?.closest('.editor-pane');
  if (focusedPane) {
    focusedPane.classList.add('focused');
  }
}

// Export functions for main module compatibility
export { 
  initTripleEditors as initEditor,
  openFileInNextEditor as loadFileInEditor,
  showDiffInEditor3 as showDiff
};