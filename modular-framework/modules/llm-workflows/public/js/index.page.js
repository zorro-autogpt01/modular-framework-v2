const state = {
  workflows: [],
  current: null,
  currentStepIdx: -1,
  runs: [],
  models: [],
  runners: [] // <--- NEW
};

// PUT IN TOKEN!!!!!!!!!!!

const INTERNAL_TOKEN_KEY = 'internal_api_token';
function authHeaders(h = {}) {
  const t = localStorage.getItem(INTERNAL_TOKEN_KEY);
  return t ? { ...h, Authorization: `Bearer ${t}` } : h;
}


// Helpers
const $ = (id) => document.getElementById(id);
function toast(m) { alert(m); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function fmtJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function parseJson(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }

// ---- Prompt preview helpers ----
function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, (_m, key) => {
    const parts = String(key).split('.');
    let cur = vars || {};
    for (const p of parts) {
      if (cur && typeof cur === 'object' && p in cur) cur = cur[p]; else return '';
    }
    return (cur === undefined || cur === null) ? '' : String(cur);
  });
}
function buildSystemGuard(schema) {
  const schemaStr = typeof schema === 'string' ? schema : JSON.stringify(schema || {}, null, 2);
  return [
    'You are a controller that MUST return a single JSON object and nothing else.',
    'Rules:',
    '- Do NOT include explanations, markdown, or code fences.',
    '- Output MUST be valid JSON that matches the schema exactly.',
    '- No trailing commas. No comments.',
    'JSON Schema:',
    schemaStr
  ].join('\n');
}
function computeFullPromptForStep(step, vars) {
  if (!step) return '';
  const sys = (step.systemGuard === false)
    ? (step.system || '')
    : buildSystemGuard(step.schema);
  const user = renderTemplate(step.prompt || '', vars || {});
  return [sys, user].filter(Boolean).join('\n\n');
}
function updateTestButtonTooltip() {
  const step = state.current?.steps?.[state.currentStepIdx];
  const vars = parseJson($('varsInput')?.value || '{}', {});
  const full = computeFullPromptForStep(step, vars);
  const btn = $('testStepBtn');
  if (btn) btn.title = full || 'No prompt';
}
function updatePromptPreview() {
  const pre = $('promptPreview');
  if (!pre) return;
  const step = state.current?.steps?.[state.currentStepIdx];
  const vars = parseJson($('varsInput')?.value || '{}', {});
  pre.textContent = computeFullPromptForStep(step, vars) || '';
}



// Gateway models
async function fetchGatewayModels() {
  console.log('[fetchGatewayModels] Starting fetch...');
  try {
    const r = await fetch('/llm-gateway/api/models', { credentials: 'include' });
    const data = await safeJson(r);
    if (!r.ok) {
      console.warn('[fetchGatewayModels] Failed:', data?.error || data);
      state.models = [];
    } else {
      state.models = data.items || [];
      console.log('[fetchGatewayModels] Loaded models:', state.models.length, state.models);
    }
  } catch (e) {
    console.warn('[fetchGatewayModels] Exception:', e.message || e);
    state.models = [];
  }
  populateModelSelects();
}
function modelOptionLabel(m) {
  const name = m.display_name || m.model_name;
  const prov = m.provider_name || m.provider_kind || '';
  const mode = m.mode && m.mode !== 'auto' ? ` · ${m.mode}` : '';
  const inC = Number(m.input_cost_per_million || 0);
  const outC = Number(m.output_cost_per_million || 0);
  const cost = (inC || outC) ? ` · $${inC}/$${outC}` : '';
  return `${name} · ${prov}${mode}${cost}`;
}
function populateModelSelect(selectEl, infoEl, currentValue) {
  console.log(`[populateModelSelect] Called for ${selectEl?.id}, currentValue: "${currentValue}"`);
  if (!selectEl) {
    console.warn('[populateModelSelect] selectEl is null');
    return;
  }
  selectEl.innerHTML = '';

  // Add default option
  const def = document.createElement('option');
  def.value = '';
  
  // Different default text for step vs main model select
  const isStepSelect = selectEl.id === 'sModelSelect';
  if (isStepSelect) {
    def.textContent = state.current?.chat?.model 
      ? `— Inherit from workflow (${state.current.chat.model}) —`
      : '— Select model —';
  } else {
    def.textContent = state.models.length
      ? '-- Select from llm-gateway --'
      : '— No models from gateway (click ↻ to refresh) —';
  }
  selectEl.appendChild(def);

  console.log(`[populateModelSelect] Adding ${state.models.length} models to ${selectEl.id}`);
  for (const m of state.models) {
    const opt = document.createElement('option');
    opt.value = m.model_name;
    opt.textContent = modelOptionLabel(m);
    opt.dataset.provider = m.provider_kind || '';
    opt.dataset.baseUrl = m.provider_base_url || '';
    opt.dataset.displayName = m.display_name || '';
    opt.dataset.currency = m.currency || 'USD';
    selectEl.appendChild(opt);
  }
  
  // Select current value if found
  const val = String(currentValue || '');
  const found = Array.from(selectEl.options).find(o => o.value === val);
  console.log(`[populateModelSelect] Looking for value "${val}", found: ${!!found}`);
  selectEl.value = found ? val : '';
  
  if (infoEl) {
    if (found) {
      const m = state.models.find(x => x.model_name === val);
      infoEl.textContent = m ? `Provider: ${m.provider_kind} · Base: ${m.provider_base_url}` : '';
    } else {
      infoEl.textContent = '';
    }
  }
  console.log(`[populateModelSelect] Final select value: "${selectEl.value}"`);
}
function populateModelSelects() {
  console.log('[populateModelSelects] Called');
  console.log('[populateModelSelects] Current workflow model:', state.current?.chat?.model);
  console.log('[populateModelSelects] Current step index:', state.currentStepIdx);
  
  // Main workflow model
  populateModelSelect($('modelSelect'), $('modelInfo'), state.current?.chat?.model || '');
  
  // Step model (only populate if a step is selected)
  if (state.currentStepIdx >= 0 && state.current?.steps?.[state.currentStepIdx]) {
    const stepModel = state.current.steps[state.currentStepIdx].model || '';
    console.log('[populateModelSelects] Step model:', stepModel);
    populateModelSelect($('sModelSelect'), $('sModelInfo'), stepModel);
  } else {
    console.log('[populateModelSelects] No step selected, skipping step model select');
  }
}


function onModelSelectChanged(isStep=false) {
  console.log(`[onModelSelectChanged] isStep: ${isStep}`);
  
  const select = isStep ? $('sModelSelect') : $('modelSelect');
  const input = isStep ? $('sModel') : $('model');
  const provEl = isStep ? $('sProvider') : $('provider');
  const baseEl = isStep ? $('sBaseUrl') : $('baseUrl');
  const infoEl = isStep ? $('sModelInfo') : $('modelInfo');

  console.log(`[onModelSelectChanged] Select element: ${select?.id}, value: "${select?.value}"`);
  console.log(`[onModelSelectChanged] Hidden input element: ${input?.id}`);

  if (!select || !input) {
    console.error('[onModelSelectChanged] Required elements not found');
    return;
  }

  const val = select.value;
  input.value = val || '';
  console.log(`[onModelSelectChanged] Set hidden input value to: "${input.value}"`);
  
  const opt = select.selectedOptions?.[0];
  const prov = opt?.dataset?.provider || '';
  const base = opt?.dataset?.baseUrl || '';

  console.log(`[onModelSelectChanged] Provider: "${prov}", Base URL: "${base}"`);

  // Only update provider/baseUrl if they're empty
  if (prov && provEl && (!provEl.value || provEl.value === '')) {
    provEl.value = prov;
    console.log(`[onModelSelectChanged] Updated provider to: "${prov}"`);
  }
  if (base && baseEl && (!baseEl.value || baseEl.value === '')) {
    baseEl.value = base;
    console.log(`[onModelSelectChanged] Updated base URL to: "${base}"`);
  }
  
  if (infoEl) {
    infoEl.textContent = val ? `Provider: ${prov} · Base: ${base}` : '';
  }
}
// Default workflow/step creators
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
  const currentModel = state.current?.chat?.model || '';
  return {
    id: `step_${Date.now().toString(36)}`,
    name: 'Step',
    prompt: 'Given the task: {{task}}\nReturn actions to perform.\n',
    schema: defaultActionSchema(),
    systemGuard: true,
    stopOnFailure: true,
    exportPath: '',
    exportAs: '',
    provider: '',
    baseUrl: '',
    apiKey: '',
    model: currentModel,
    temperature: '',
    target: ''   // <--- NEW
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

// Load workflows with safe JSON handling
async function loadWorkflows() {
  try {
    const resp = await fetch('./api/workflows');
    const data = await safeJson(resp);
    if (!resp.ok) {
      console.warn('Workflows load failed:', data);
      state.workflows = [];
    } else {
      state.workflows = data.workflows || [];
    }
  } catch (e) {
    console.warn('Failed to load workflows:', e);
    state.workflows = [];
  }
  renderWorkflowList();
}

// Save current workflow
async function saveCurrent() {
  const wf = collectWorkflowFromForm();
  try {
    const resp = await fetch('./api/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(wf)
    });
    const data = await safeJson(resp);
    if (!resp.ok || !data.ok) {
      toast('Save failed: ' + (data?.error || resp.statusText));
      return;
    }
    state.current = data.workflow;
    state.current.chat = {
      provider: $('provider').value,
      baseUrl: $('baseUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim(),  // This reads from the hidden input
      temperature: $('temperature').value !== '' ? Number($('temperature').value) : undefined,
      max_tokens: $('max_tokens').value !== '' ? Number($('max_tokens').value) : undefined
    };
    const idx = state.workflows.findIndex(w => w.id === state.current.id);
    if (idx >= 0) state.workflows[idx] = state.current; else state.workflows.push(state.current);
    renderWorkflowList();
    renderWorkflowEditor();
    toast('Saved');
  } catch (e) {
    toast('Save failed: ' + e.message);
  }
}


async function fetchRunners() {
  try {
    const r = await fetch('./api/runners');
    const data = await r.json();
    state.runners = data.runners || [];
  } catch {
    state.runners = [];
  }
  populateRunnersSelect();
}
function populateRunnersSelect() {
  const sel = $('sTarget'); const info = $('sTargetInfo');
  if (!sel) return;
  const val = (state.current?.steps?.[state.currentStepIdx]?.target) || '';
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = ''; none.textContent = '— local (no runner) —';
  sel.appendChild(none);
  for (const r of state.runners) {
    const opt = document.createElement('option');
    opt.value = r.name;
    opt.textContent = `${r.name} (${r.url})`;
    sel.appendChild(opt);
  }
  sel.value = val || '';
  if (info) {
    const found = state.runners.find(x => x.name === sel.value);
    info.textContent = found ? `URL: ${found.url} · default cwd: ${found.default_cwd || '(none)'}` : '';
  }
}


// Delete current
async function deleteCurrent() {
  if (!state.current?.id) { toast('Nothing selected'); return; }
  if (!confirm('Delete this workflow?')) return;
  try {
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
  } catch (e) {
    toast('Delete failed: ' + e.message);
  }
}

// Run current workflow
async function runCurrent() {
  const wf = collectWorkflowFromForm();
  if (!wf.id) {
    toast('Please save the workflow before running.');
    return;
  }
  const vars = parseJson($('varsInput').value || '{}', {});
  try {
    const resp = await fetch(`./api/workflows/${wf.id}/run`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ vars })
    });
    const data = await safeJson(resp);
    if (!resp.ok) {
      toast('Run failed: ' + (data?.error || resp.statusText));
      return;
    }
    renderRunResult(data);
    await loadRuns();
  } catch (e) {
    toast('Run failed: ' + e.message);
  }
}

// Test selected step (robust)
async function testStep() {
  const wf = collectWorkflowFromForm();
  const step = wf.steps[state.currentStepIdx];
  if (!step) { toast('Select a step'); return; }
  const vars = parseJson($('varsInput').value || '{}', {});
  try { updateTestButtonTooltip(); } catch {}

  try {
    const resp = await fetch('./api/testStep', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ chat: wf.chat, step, vars, execute: $('execInTest')?.checked === true })
    });
    const data = await safeJson(resp);
    if (!resp.ok) {
      toast('Step test failed: ' + (data?.error || resp.statusText));
      // Still render something if possible
      renderStepTestResult({ ok:false, error: data?.error || 'HTTP error', raw: data?.errorText || '' });
      return;
    }
    renderStepTestResult(data);
  } catch (e) {
    toast('Step test failed: ' + e.message);
  }
}

// Collect from form fields
function collectWorkflowFromForm() {
  console.log('[collectWorkflowFromForm] Called');
  if (!state.current) state.current = newWorkflow();

  const modelValue = $('model')?.value?.trim() || '';
  console.log(`[collectWorkflowFromForm] Main model value: "${modelValue}"`);

  state.current.name = $('wfName').value.trim();
  state.current.description = $('wfDesc').value;
  state.current.chat = {
    provider: $('provider').value,
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: modelValue,
    temperature: $('temperature').value !== '' ? Number($('temperature').value) : undefined,
    max_tokens: $('max_tokens').value !== '' ? Number($('max_tokens').value) : undefined
  };
  state.current.defaults = parseJson($('defaults').value || '{}', {});
  
  // Steps
  if (state.currentStepIdx >= 0 && state.current.steps[state.currentStepIdx]) {
    const s = state.current.steps[state.currentStepIdx];
    const stepModelValue = $('sModel').value.trim();
    console.log(`[collectWorkflowFromForm] Step model value: "${stepModelValue}"`);
    
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
    s.model = stepModelValue;
    s.target = $('sTarget')?.value || '';
    s.temperature = $('sTemp').value !== '' ? Number($('sTemp').value) : '';
    
    console.log(`[collectWorkflowFromForm] Updated step model to: "${s.model}"`);
  }
  return state.current;
}

// Rendering
function renderWorkflowList() {
  const list = $('wfList');
  list.innerHTML = '';
  state.workflows.forEach(w => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <div><strong>${escapeHtml(w.name)}</strong>
        <span class="pill">${w.chat?.provider || 'openai'} · ${w.chat?.model || '(model)'} </span>
        <span class="muted">${w.updatedAt || ''}</span>
      </div>
      <button class="ghost">Open</button>
    `;
    const btn = div.querySelector('button');
    btn.onclick = async () => {
      try {
        const resp = await fetch(`./api/workflows/${w.id}`);
        const data = await safeJson(resp);
        if (!resp.ok) {
          toast('Load workflow failed: ' + (data?.error || resp.statusText));
          return;
        }
        state.current = data.workflow;
        state.currentStepIdx = -1;
        renderWorkflowEditor();
        $('tabBtnBuilder').click();
      } catch (e) {
        toast('Load workflow failed: ' + e.message);
      }
    };
    list.appendChild(div);
  });
}

function renderWorkflowEditor() {
  const pane = $('builderPane');
  if (!state.current) {
    pane.style.display = '';
    $('wfName').value = '';
    $('wfDesc').value = '';
    $('provider').value = 'openai';
    $('baseUrl').value = '';
    $('apiKey').value = '';
    $('model').value = '';
    $('temperature').value = '';
    $('max_tokens').value = '';
    $('defaults').value = '{}';
    populateModelSelects();
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
  populateModelSelects();
  renderSteps();
  renderStepEditor();
}

function renderSteps() {
  const list = $('stepsList');
  list.innerHTML = '';
  const steps = state.current?.steps || [];
  steps.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'item';
    row.innerHTML = `
      <div><strong>${escapeHtml(s.name || s.id)}</strong>
        <span class="pill">${s.model || state.current?.chat?.model || '(model)'}</span>
        <span class="pill">${s.target ? ('→ ' + escapeHtml(s.target)) : 'local'}</span>
      </div>
      <button class="ghost">Up</button>
      <button class="ghost">Down</button>
      <button class="ghost">Edit</button>
      <button class="danger">Remove</button>
    `;
    const [_, bUp, bDown, bEdit, bRm] = row.children;
    bUp.onclick = () => { moveStep(idx, -1); };
    bDown.onclick = () => { moveStep(idx, +1); };
    bEdit.onclick = () => { state.currentStepIdx = idx; renderStepEditor(); };
    bRm.onclick = () => { removeStep(idx); };
    list.appendChild(row);
  });
}

function renderStepEditor() {
  console.log('[renderStepEditor] Called');
  const steps = state.current?.steps || [];
  const s = steps[state.currentStepIdx];
  const noStep = !s;
  console.log(`[renderStepEditor] Current step index: ${state.currentStepIdx}, step exists: ${!noStep}`);
  
  $('stepEditor').style.display = noStep ? 'none' : '';
  $('noStepHint').style.display = noStep ? '' : 'none';
  if (noStep) return;

  console.log(`[renderStepEditor] Step model: "${s.model}"`);
  
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
  $('sModel').value = s.model || '';  // Set the hidden input
  console.log(`[renderStepEditor] Set hidden input sModel to: "${$('sModel').value}"`);
  
  $('sTemp').value = s.temperature ?? '';
  
  // Now populate the select with the step's model value directly
  console.log(`[renderStepEditor] About to populate select with model: "${s.model || ''}"`);
  populateRunnersSelect();
  populateModelSelect($('sModelSelect'), $('sModelInfo'), s.model || '');
  updateTestButtonTooltip();
  updatePromptPreview();
}

function removeStep(idx) {
  state.current.steps.splice(idx, 1);
  if (state.currentStepIdx === idx) state.currentStepIdx = -1;
  renderSteps();
  renderStepEditor();
}

function moveStep(idx, delta) {
  const steps = state.current.steps;
  const j = idx + delta;
  if (j < 0 || j >= steps.length) return;
  const [m] = steps.splice(idx, 1);
  steps.splice(j, 0, m);
  if (state.currentStepIdx === idx) state.currentStepIdx = j;
  renderSteps();
}

function addStep() {
  if (!state.current) state.current = newWorkflow();
  
  // IMPORTANT: Collect form data first so the model is available for inheritance
  collectWorkflowFromForm();
  
  state.current.steps.push(newStep());
  state.currentStepIdx = state.current.steps.length - 1;
  renderSteps();
  renderStepEditor();
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Runs
async function loadRuns() {
  try {
    const resp = await fetch('./api/runs');
    const data = await safeJson(resp);
    if (!resp.ok) {
      console.warn('Runs load failed:', data);
      state.runs = [];
    } else {
      state.runs = data.runs || [];
    }
  } catch (e) {
    console.warn('Runs load failed:', e);
    state.runs = [];
  }
  renderRuns();
}
function renderRuns() {
  const list = $('runsList');
  list.innerHTML = '';
  state.runs.slice().reverse().forEach(r => {
    const item = document.createElement('div');
    item.className = 'item';
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(r.name)}</strong>
        <span class="pill">${r.status}</span>
        <span class="muted">Run ${r.id.slice(0,8)} · ${r.startedAt}</span>
      </div>
      <button class="ghost">Details</button>
    `;
    item.querySelector('button').onclick = () => renderRunResult(r);
    list.appendChild(item);
  });
}

function renderRunResult(run) {
  $('tabBtnRuns').click();
  $('runDetail').innerHTML = `
    <div class="card">
      <div><strong>${escapeHtml(run.name)}</strong> <span class="pill">${run.status}</span></div>
      <div class="muted">Started: ${run.startedAt} · Finished: ${run.finishedAt || ''}</div>
      <h4>Artifacts (${run.artifacts?.length || 0})</h4>
      ${renderArtifacts(run.artifacts || [])}
      <h4>Logs</h4>
      <pre class="log">${(run.logs || []).map(l => `[${l.ts}] [${l.step || '-'}] ${l.level.toUpperCase()} ${l.msg}${l.meta ? ' ' + JSON.stringify(l.meta) : ''}`).join('\n')}</pre>
    </div>
  `;
}

function renderArtifacts(artifacts) {
  if (!artifacts.length) return '<div class="muted">No artifacts</div>';
  return artifacts.map((a, idx) => `
    <div class="artifact">
      <div><span class="pill">${a.type}</span> <span class="muted">from: ${escapeHtml(a.step || '')}</span></div>
      ${a.filename ? `<div class="muted">file: ${escapeHtml(a.filename)}</div>` : ''}
      <pre class="code">${escapeHtml(a.content || '')}</pre>
    </div>
  `).join('');
}

function renderStepTestResult(data) {
  $('testOutput').innerHTML = `
    <div class="card">
      <div><strong>OK:</strong> ${String(!!data.ok)}</div>
      <h4>Validation</h4>
      <pre>${escapeHtml(JSON.stringify(data.validation || {}, null, 2))}</pre>
      <h4>JSON</h4>
      <pre>${escapeHtml(JSON.stringify(data.json || {}, null, 2))}</pre>
      <h4>Raw</h4>
      <pre class="log">${escapeHtml(((data.raw || data.error || '') + '').slice(0, 4000))}</pre>
      <h4>Artifacts (${data.artifacts?.length || 0})</h4>
      ${(data.actionResults && data.actionResults.length) ? `
        <h4>Action Results (${data.actionResults.length})</h4>
        ${data.actionResults.map(r => `
          <div class="artifact">
            <div><span class="pill">${escapeHtml(r.kind || '')}</span> <span class="muted">index: ${r.index}</span></div>
            ${r.skipped ? `<div class="muted">skipped: ${escapeHtml(r.reason||'')}</div>` : `
              ${r.error ? `<div class="error">error: ${escapeHtml(r.error)}</div>` : `
                <div class="muted">exit: ${String(r.exitCode)} ${r.killed?'(killed)':''}</div>
                <div class="muted">stdout:</div>
                <pre class="log">${escapeHtml((r.stdout || '').slice(0, 4000))}</pre>
                <div class="muted">stderr:</div>
                <pre class="log">${escapeHtml((r.stderr || '').slice(0, 4000))}</pre>
              `}
            `}
          </div>
        `).join('')}
      ` : ''}
      <h4>Step Logs</h4>
      <pre class="log">${(data.logs || []).map(l => `[${l.ts}] ${l.level.toUpperCase()} ${l.msg}${l.meta ? ' ' + JSON.stringify(l.meta) : ''}`).join('\n')}</pre>
    </div>
  `;
}

// Tabs
function activateTab(name) {
  const tabs = ['builder', 'runs'];
  tabs.forEach(t => {
    $(`tab-${t}`).style.display = (t === name) ? '' : 'none';
    $(`tabBtn${capitalize(t)}`).classList.toggle('active', t === name);
  });
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Safe JSON helper
async function safeJson(res) {
  const txt = await res.text().catch(() => '');
  try { return JSON.parse(txt); }
  catch { return { errorText: txt }; }
}

// Wire up events
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[DOMContentLoaded] Starting initialization');

  $('tabBtnBuilder').addEventListener('click', () => activateTab('builder'));
  $('tabBtnRuns').addEventListener('click', () => activateTab('runs'));
  $('newWfBtn').addEventListener('click', () => { state.current = newWorkflow(); state.currentStepIdx = -1; renderWorkflowEditor(); });
  $('saveWfBtn').addEventListener('click', saveCurrent);
  $('deleteWfBtn').addEventListener('click', deleteCurrent);
  $('addStepBtn').addEventListener('click', addStep);
  $('testStepBtn').addEventListener('click', testStep);
  $('runWfBtn').addEventListener('click', runCurrent);
  $('sModelSelect')?.addEventListener('change', () => onModelSelectChanged(true));
  $('refreshModelsBtn2')?.addEventListener('click', fetchGatewayModels);

  $('refreshRunnersBtn')?.addEventListener('click', fetchRunners);
  await fetchRunners(); // call once on load
  $('sTarget')?.addEventListener('change', () => {
    collectWorkflowFromForm();
    // update the info line without rebuilding the whole select
    const info = $('sTargetInfo');
    const val = $('sTarget')?.value || '';
    const found = state.runners.find(x => x.name === val);
    if (info) info.textContent = found ? `URL: ${found.url} · default cwd: ${found.default_cwd || '(none)'}` : '';
  });

  // Keep form changes in state for current step
  ['wfName','wfDesc','provider','baseUrl','apiKey','model','temperature','max_tokens','defaults',
   'stepName','stepPrompt','stepSchema','stepNoGuard','stepDontStop','stepExportPath','stepExportAs',
   'sProvider','sBaseUrl','sApiKey','sModel','sTemp','sTarget'
  ].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => { collectWorkflowFromForm(); updateTestButtonTooltip(); updatePromptPreview(); });
    if (el && el.tagName === 'TEXTAREA') el.addEventListener('input', () => { collectWorkflowFromForm(); updateTestButtonTooltip(); updatePromptPreview(); });
  });

  // Model selects
  $('modelSelect')?.addEventListener('change', () => onModelSelectChanged(false));
  $('refreshModelsBtn')?.addEventListener('click', fetchGatewayModels);
  const elements = ['modelSelect', 'model', 'modelInfo', 'sModelSelect', 'sModel', 'sModelInfo'];
  for (const id of elements) {
    const el = $(id);
    console.log(`[DOMContentLoaded] Element ${id}: ${el ? 'found' : 'NOT FOUND'}`);
  }
  
  
  activateTab('builder');

  // Load data; failures won’t prevent handlers from being bound
  await fetchGatewayModels();
  await loadWorkflows();
  await loadRuns();

  $('varsInput')?.addEventListener('input', () => { updateTestButtonTooltip(); updatePromptPreview(); });

  // Copy / Download actions for the preview (no-op if not present)
  $('copyPromptBtn')?.addEventListener('click', () => {
    const text = $('promptPreview')?.textContent || '';
    navigator.clipboard?.writeText(text);
  });
  $('downloadPromptBtn')?.addEventListener('click', () => {
    const text = $('promptPreview')?.textContent || '';
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'prompt.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });
});