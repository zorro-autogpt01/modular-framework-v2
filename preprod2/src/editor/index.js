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
  document.getElementById('monaco-diff').classList.add('hidden');
  document.getElementById('monaco-editor').classList.remove('hidden');
  const model = monaco.editor.createModel(fileData.content, language);
  state.editor.setModel(model);
}

export function showDiff(){
  if (!state.activeFile) return;
  const data = state.openFiles.get(state.activeFile); if (!data) return;
  document.getElementById('monaco-editor').classList.add('hidden');
  document.getElementById('monaco-diff').classList.remove('hidden');
  const lang = getLanguageFromPath(state.activeFile);
  const originalModel = monaco.editor.createModel(data.originalContent, lang);
  const modifiedModel = monaco.editor.createModel(data.content, lang);
  state.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
}

export function toggleMinimap(){
  const minimap = state.editor.getOption(monaco.editor.EditorOption.minimap);
  state.editor.updateOptions({ minimap: { enabled: !minimap.enabled } });
}

export function getEditorValue(){ return state.editor ? state.editor.getValue() : ''; }
