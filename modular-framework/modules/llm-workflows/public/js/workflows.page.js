import { getGlobal, getProfiles, getActiveName } from './storage.js';
import { listWorkflows, saveWorkflow, deleteWorkflow, getWorkflow, newWorkflowTemplate } from './workflows.store.js';
import { WF_SCHEMAS, runWorkflow } from './workflows.run.js';

let state = {
  workflows: [],
  current: null,
  currentStepIdx: -1,
  runs: []
};

// Helpers
const el = (id) => document.getElementById(id);
const $ = (id) => document.getElementById(id);
function toast(m){ alert(m); }
function clone(x){ return JSON.parse(JSON.stringify(x)); }
function fmtJson(v){ try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function parseJson(text, fallback = null){ try { return JSON.parse(text); } catch { return fallback; } }

function newWorkflow() {
  return {
    id: null,
    name: 'New Workflow',
    description: '',
    defaults: {},
    chat: { provider: 'openai', baseUrl: '', apiKey: '', model: '', temperature: 0.2 },
    steps: [],
    createdAt: null,
    updatedAt: null
  };
}
function newStep() {
  return {
    id: `step_${Date.now().toString(36)}`,
    name: 'Step',
    prompt: 'Given the task: {{task}}\nReturn actions to perform.\n',
    schema: defaultActionSchema(),
    systemGuard: true,
    stopOnFailure: true,
    exportPath: '', // optional path in JSON to export as variable
    exportAs: '',   // optional name for exported var
    // optional overrides:
    provider: '',
    baseUrl: '',
    apiKey: '',
    model: '',
    temperature: ''
  };
}
function defaultActionSchema() {
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    required: ['actions'],
    additionalProperties: false,
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'content'],
          properties: {
            type: { type: 'string', enum: ['bash', 'python', 'sql', 'http', 'plan', 'text'] },
            content: { type: 'string' },
            filename: { type: 'string' },
            cwd: { type: 'string' },
            env: { type: 'object', additionalProperties: { type: 'string' } },
            meta: { type: 'object' }
          }
        }
      },
      notes: { type: 'string' }
    }
  };
}

// Load workflows
async function loadWorkflows() {
  const resp = await fetch('./api/workflows');
  const data = await resp.json();
  state.workflows = data.workflows || [];
  renderWorkflowList();
}

// Save current workflow
async function saveCurrent() {
  const wf = collectWorkflowFromForm();
  if (!wf.name) { toast('Workflow must have a name'); return; }
  const resp = await fetch('./api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wf)
  });
  const data = await resp.json();
  if (!data.ok) {
    toast('Save failed: ' + (data.error || 'Unknown'));
    return;
  }
  state.current = data.workflow;
  // Update collection
  const idx = state.workflows.findIndex(w => w.id === state.current.id);
  if (idx >= 0) state.workflows[idx] = state.current; else state.workflows.push(state.current);
  renderWorkflowList();
  renderWorkflowEditor();
  toast('Saved');
}

// Delete current
async function deleteCurrent() {
  if (!state.current?.id) return toast('No workflow selected');
  if (!confirm('Delete this workflow?')) return;
  const resp = await fetch(`./api/workflows/${state.current.id}`, { method: 'DELETE' });
  if (resp.ok) {
    state.workflows = state.workflows.filter(w => w.id !== state.current.id);
    state.current = null;
    state.currentStepIdx = -1;
    renderWorkflowList();
    renderWorkflowEditor();
  } else {
    toast('Delete failed');
  }
}

// Run current workflow
async function runCurrent() {
  if (!state.current?.id) return toast('Please select or save a workflow first.');
  const wf = state.current;
  const inputs = {}; // user could wire inputs later
  const llmConfig = profileToLlmConfig();
  const runPayload = {
    workflow: wf,
    inputVars: inputs,
    llmConfig,
    logFn: (text) => { /* optional: could push to a UI log */ }
  };
  const res = await runWorkflow(runPayload);
  renderRunResult(res);
}

// Test selected step
async function testStep() {
  const wf = state.current;
  const step = wf?.steps?.[state.currentStepIdx];
  if (!step) { toast('Select a step'); return; }
  const vars = parseJson($('varsInput').value || '{}', {});
  // Update tooltip before sending
  try {
    const full = computeFullPromptForStep(step, vars);
    const btn = $('testStepBtn');
    if (btn) btn.title = full;
  } catch { /* ignore */ }

  const resp = await fetch('./api/testStep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat: wf.chat, step, vars })
  });
  const data = await resp.json();
  renderStepTestResult(data);
}

// Collect from form fields
function collectWorkflowFromForm(){
  if (!state.current) state.current = newWorkflow();

  state.current.name = $('wfName').value.trim();
  state.current.description = $('wfDesc').value;
  state.current.chat = {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    temperature: $('temperature').value !== '' ? Number($('temperature').value) : undefined,
    max_tokens: $('max_tokens').value !== '' ? Number($('max_tokens').value) : undefined
  };
  state.current.defaults = parseJson($('defaults').value || '{}', {});
  // Steps
  if (state.currentStepIdx >= 0 && state.current.steps[state.currentStepIdx]) {
    const s = state.current.steps[state.currentStepIdx];
    s.name = $('stepName').value.trim();
    s.prompt = $('stepPrompt').value;
    s.systemGuard = !$('stepNoGuard').checked;
    s.schema = parseJson($('stepSchema').value || '', s.schema);
    s.stopOnFailure = !$('stepDontStop').checked;
    s.exportPath = $('stepExportPath').value.trim();
    s.exportAs = $('stepExportAs').value.trim();
    s.provider = $('sProvider').value.trim();
    s.baseUrl = $('sBaseUrl').value.trim();
    s.apiKey = $('sApiKey').value.trim();
    s.model = $('sModel').value.trim();
    s.temperature = $('sTemp').value !== '' ? Number($('sTemp').value) : '';
  }
  return state.current;
}

// Rendering
function renderWorkflowList() {
  const list = el('wfList'); list.innerHTML = '';
  const active = getActiveName() || state.workflows[0]?.name;
  state.workflows.forEach((p, idx) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div>
        <strong>${escapeHtml(p.name)}</strong>
        <span class="pill">${p.chat?.provider || 'openai'} · ${p.chat?.model || '(model)'} </span>
        <span class="muted">${p.updatedAt || ''}</span>
      </div>
      <button class="ghost">Open</button>
    `;
    const btn = div.querySelector('button');
    btn.onclick = async () => {
      const resp = await fetch(`./api/workflows/${p.id}`);
      const data = await resp.json();
      state.current = data.workflow;
      state.currentStepIdx = -1;
      renderWorkflowEditor();
      $('tabBtnBuilder').click();
    };
    list.appendChild(div);
  });
}

function renderWorkflowEditor(){
  const pane = el('builderPane');
  if (!state.current){
    pane.style.display = '';
    $('wfName').value = ''; $('wfDesc').value = '';
    $('provider').value = 'openai';
    $('baseUrl').value = '';
    $('apiKey').value = '';
    $('model').value = '';
    $('temperature').value = '';
    $('max_tokens').value = '';
    $('defaults').value = '{}';
    renderSteps();
    renderStepEditor();
    return;
  }
  $('wfName').value = state.current.name || '';
  $('wfDesc').value = state.current.description || '';
  $('provider').value = state.current.chat?.provider || 'openai';
  $('baseUrl').value = state.current.chat?.baseUrl || '';
  $('apiKey').value = state.current.chat?.apiKey || '';
  $('model').value = state.current.chat?.model || '';
  $('temperature').value = state.current.chat?.temperature ?? '';
  $('max_tokens').value = state.current.chat?.max_tokens ?? '';
  $('defaults').value = fmtJson(state.current.defaults || {});
  renderSteps();
  renderStepEditor();
}

// Steps
function renderSteps(){
  const list = el('stepsList');
  list.innerHTML = '';
  const steps = state.current?.steps || [];
  steps.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div><strong>${escapeHtml(s.name || s.id)}</strong>
        <span class="pill">${s.model || state.current?.chat?.model || '(model)'}</span>
      </div>
      <button class="ghost">Up</button>
      <button class="ghost">Down</button>
      <button class="ghost">Edit</button>
      <button class="danger">Remove</button>
      <span class="badge">id: ${s.id}</span>
    `;
    const [_, upBtn, downBtn, editBtn, delBtn, badge] = row.children;
    upBtn.onclick = () => { moveStep(idx, -1); };
    downBtn.onclick = () => { moveStep(idx, +1); };
    editBtn.onclick = () => { state.currentStepIdx = idx; renderStepEditor(); };
    delBtn.onclick = () => { removeStep(idx); };
    list.appendChild(row);
  });
}

function renderStepEditor(){
  const steps = state.current?.steps || [];
  const s = steps[state.currentStepIdx];
  const noStep = !s;
  $('stepEditor').style.display = noStep ? 'none' : '';
  $('noStepHint').style.display = noStep ? '' : 'none';
  if (noStep) return;

  $('stepName').value = s.name || '';
  $('stepPrompt').value = s.prompt || '';
  $('stepSchema').value = typeof s.schema === 'string' ? s.schema : fmtJson(s.schema || {});
  $('stepNoGuard').checked = !s.systemGuard;
  $('stepDontStop').checked = !s.stopOnFailure;
  $('stepExportPath').value = s.exportPath || '';
  $('stepExportAs').value = s.exportAs || '';
  $('sProvider').value = s.provider || '';
  $('sBaseUrl').value = s.baseUrl || '';
  $('sApiKey').value = s.apiKey || '';
  $('sModel').value = s.model || '';
  $('sTemp').value = s.temperature ?? '';

  // Update test button tooltip with the full prompt for current step
  const vars = parseJson($('varsInput').value || '{}', {});
  const full = computeFullPromptForStep(s, vars);
  const testBtn = $('testStepBtn');
  if (testBtn) testBtn.title = full;
}

// Helpers to manipulate steps
function removeStep(idx){
  const arr = state.current?.steps || [];
  if (idx < 0 || idx >= arr.length) return;
  arr.splice(idx, 1);
  if (state.currentStepIdx >= arr.length) state.currentStepIdx = arr.length - 1;
  renderSteps();
  renderStepEditor();
}
function moveStep(idx, delta){
  const steps = state.current?.steps || [];
  const j = idx + delta;
  if (j < 0 || j >= steps.length) return;
  const [m] = steps.splice(idx, 1);
  steps.splice(j, 0, m);
  if (state.currentStepIdx === idx) state.currentStepIdx = j;
  renderSteps();
}
function addStep(){
  if (!state.current) state.current = newWorkflow();
  state.current.steps.push(newStep());
  state.currentStepIdx = state.current.steps.length - 1;
  renderSteps();
  renderStepEditor();
}

// Run
function escapeHtml(s){
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Wire up events
document.addEventListener('DOMContentLoaded', async () => {
  $('tabBtnBuilder').addEventListener('click', ()=> {
    // nothing special; tabs are simple in this module
    // but keep API surface consistent
  });

  // Wire up actions
  $('tabBtnBuilder').addEventListener('click', ()=> {
    document.getElementById('tab-builder').style.display = '';
    document.getElementById('tab-runs').style.display = 'none';
  });
  $('tabBtnRuns')?.addEventListener('click', ()=> {
    document.getElementById('tab-builder').style.display = 'none';
    document.getElementById('tab-runs').style.display = '';
  });

  // Action buttons
  $('newWfBtn')?.addEventListener('click', async ()=> { state.current = newWorkflowTemplate(); await saveWorkflow(state.current); renderList(); renderEditor(); });
  $('wfSaveBtn')?.addEventListener('click', async ()=> { collectWorkflowFromForm(); saveCurrent(); });
  $('deleteWfBtn')?.addEventListener('click', deleteCurrent);
  $('addStepBtn')?.addEventListener('click', addStep);
  $('testStepBtn')?.addEventListener('click', testStep);
  $('runWfBtn')?.addEventListener('click', runCurrent);

  // Wire up helper inputs
  document.getElementById('tabBtnChat')?.addEventListener('click', ()=> {
    // no-op here; in this module we show steps/runs sections
  });

  // RAG / test UI wiring (kept minimal to focus on requested feature)
  // Persist/view
  await loadWorkflows();
  renderList(); // ensure UI in sync
  renderEditor();

  // Live tooltip update when vars change
  $( 'varsInput' )?.addEventListener('input', ()=> {
    const wf = state.current;
    const step = wf?.steps?.[state.currentStepIdx];
    const vars = parseJson($('varsInput').value || '{}', {});
    const full = computeFullPromptForStep(step, vars);
    const btn = $('testStepBtn');
    if (btn) btn.title = full;
  });

  // Live tooltip update when step fields change
  // (we rely on renderStepEditor to refresh title when editing a step)
  // Also ensure Enter/Meta shortcuts behave (optional)
  document.addEventListener('keydown', (e)=>{
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's'){
      e.preventDefault();
      saveCurrent();
    }
  });

  // Initial tooltip for first step if present
  if (state.current?.steps?.[0]) {
    const vars = parseJson($('varsInput').value || '{}', {});
    $('testStepBtn').title = computeFullPromptForStep(state.current.steps[0], vars);
  }
});

// Utility: compute the full prompt shown to the user for a given step and vars
function computeFullPromptForStep(step, vars){
  // Approximate the "system" portion. If step.systemGuard is false, show the explicit system prompt;
  // otherwise show a guard-like prompt including a reference to the schema (best-effort since WF_SCHEMAS lives in another module).
  const sysGuardDisabled = step?.systemGuard === false;
  const systemPart = sysGuardDisabled ? (step?.system || '') : (step?.systemGuard ? '' : '');
  // Best-effort hint about schema
  const schemaHint = step?.schema ? `Schema: ${step.schema}` : '';
  const guardNote = [systemPart, schemaHint].filter(Boolean).join('\n');
  // User prompt (template with vars)
  const userPart = renderTemplate(step?.prompt || '', vars || {});
  const full = [guardNote, userPart].filter(Boolean).join('\n');
  return full;
}

// Templating helper (inline small version)
function renderTemplate(tpl, vars){
  return (tpl || '').replace(/\{\{(\w+)\}\}/g, (_m, k) => {
    const val = (vars && typeof vars === 'object') ? vars[k] : undefined;
    return (val === undefined || val === null) ? '' : String(val);
  });
}

// Simple helper to render a step test result
function renderStepTestResult(data){
  // Show results; Raw section should show raw data unless empty, in which case show error or empty
  const out = document.getElementById('testOutput');
  if (!out) return;

  // Raw display logic: prefer data.raw if present and non-empty; else show data.error
  const rawText = (typeof data?.raw === 'string' && data.raw.trim()) ? data.raw : (data?.error || '');
  const rawPretty = (rawText || '').slice(0, 4000);

  const artifactsHTML = (data?.artifacts || []).length
    ? data.artifacts.map(a => `<div class="artifact"><div><span class="badge">${escapeHtml(a.type)}</span> ${escapeHtml(a.filename || '')}</div><pre class="code">${escapeHtml(a.content || '')}</pre></div>`).join('')
    : '<div class="muted">No artifacts</div>';

  out.innerHTML = `
    <div class="card">
      <div><strong>OK:</strong> ${String(!!data?.ok)}</div>
      <h4>Validation</h4>
      <pre>${escapeHtml(JSON.stringify(data?.validation || {}, null, 2))}</pre>
      <h4>JSON</h4>
      <pre>${escapeHtml(JSON.stringify(data?.json || {}, null, 2))}</pre>
      <h4>Raw</h4>
      <pre class="log">${escapeHtml(rawPretty)}</pre>
      <h4>Artifacts (${data?.artifacts?.length || 0})</h4>
      ${artifactsHTML}
      <h4>Step Logs</h4>
      <pre class="log">${(data?.logs || []).map(l => `[${l.ts}] ${l.level.toUpperCase()} ${l.msg}${l.meta ? ' ' + JSON.stringify(l.meta) : ''}`).join('\n')}</pre>
    </div>
  `;
}

// Utility: update run result (simple display)
function renderRunResult(res){
  const tabRuns = document.getElementById('tab-runs');
  if (tabRuns) tabRuns.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

// Initialize on load (exported helpers in original design)
function renderList(arr){
  // Keep compatibility with potential external calls
  // Not used directly in this patch; kept for completeness
  // This is a placeholder since we use renderWorkflowList in this file
  return;
}
function renderEditor(){ renderWorkflowEditor(); }

// End: additional exports to align with existing imports in this module