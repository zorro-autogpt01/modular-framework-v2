import { state } from '../core/state.js';
import { bus } from '../core/eventBus.js';
import { Logger } from '../core/logger.js';
import { getLanguageFromPath } from '../utils/path.js';

export function initEditor({ onCursorMove, onContentChange }){
  state.editor = monaco.editor.create(document.getElementById('monaco-editor'), {
    value: '', language: 'markdown', theme: 'vs-dark', automaticLayout: true,
    minimap: { enabled: true }, scrollBeyondLastLine: false, fontSize: 14, lineNumbers: 'on', wordWrap: 'on', cursorBlinking: 'blink',
    quickSuggestions: true, suggestOnTriggerCharacters: true, formatOnPaste: true, formatOnType: true
  });
  state.diffEditor = monaco.editor.createDiffEditor(document.getElementById('monaco-diff'), { theme: 'vs-dark', automaticLayout: true, readOnly: false });
  state.editor.onDidChangeCursorPosition((e)=> onCursorMove?.(e.position));
  state.editor.onDidChangeModelContent(()=>{
    if (state.activeFile) {
      const fileData = state.openFiles.get(state.activeFile);
      if (!fileData) return;
      const current = state.editor.getValue();
      fileData.content = current;
      fileData.modified = current !== fileData.originalContent;
      bus.emit('ui:tabs:update');
      bus.emit('ui:fileTree:selection');
      onContentChange?.();
    }
  });
  bus.on('ui:tabs:update', ()=>{
    // No-op placeholder for any editor-specific tab updates
  });
}

export function loadFileInEditor(filePath){
  const fileData = state.openFiles.get(filePath);
  if (!fileData) return;
  const language = getLanguageFromPath(filePath);
  const diffEl = document.getElementById('monaco-diff');
  const editorEl = document.getElementById('monaco-editor');

  // Hide diff, show main editor
  diffEl.classList.add('hidden');
  editorEl.classList.remove('hidden');

  // Dispose any previous diff models to avoid leaks
  if (state.diffModels) {
    try { state.diffModels.original.dispose(); } catch {}
    try { state.diffModels.modified.dispose(); } catch {}
    state.diffModels = null;
  }

  // Create or reuse a model for this file
  let model = fileData.model;
  if (!model || model.isDisposed?.()) {
    const uri = monaco.Uri.parse(`inmemory://${filePath}`);
    model = monaco.editor.createModel(fileData.content ?? '', language, uri);
    fileData.model = model;
  } else {
    monaco.editor.setModelLanguage(model, language);
    if (model.getValue() !== fileData.content) model.setValue(fileData.content);
  }

  state.editor.setModel(model);
}

export function showDiff(){
  if (!state.activeFile) return;
  const data = state.openFiles.get(state.activeFile); if (!data) return;

  const editorEl = document.getElementById('monaco-editor');
  const diffEl = document.getElementById('monaco-diff');
  editorEl.classList.add('hidden');
  diffEl.classList.remove('hidden');

  const lang = getLanguageFromPath(state.activeFile);

  // Dispose previous diff models
  if (state.diffModels) {
    try { state.diffModels.original.dispose(); } catch {}
    try { state.diffModels.modified.dispose(); } catch {}
    state.diffModels = null;
  }

  const originalModel = monaco.editor.createModel(data.originalContent ?? '', lang, monaco.Uri.parse(`inmemory://diff/original/${state.activeFile}`));
  const modifiedModel = monaco.editor.createModel(data.content ?? '', lang, monaco.Uri.parse(`inmemory://diff/modified/${state.activeFile}`));

  state.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
  state.diffModels = { original: originalModel, modified: modifiedModel };
}

export function toggleMinimap(){
  const minimap = state.editor.getOption(monaco.editor.EditorOption.minimap);
  state.editor.updateOptions({ minimap: { enabled: !minimap.enabled } });
}

export function getEditorValue(){ return state.editor ? state.editor.getValue() : ''; }
