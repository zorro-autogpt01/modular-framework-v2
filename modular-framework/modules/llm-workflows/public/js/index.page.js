const state = {
  workflows: [],
  current: null,
  currentStepIdx: -1,
  runs: []
};

// Helpers
const $ = (id) => document.getElementById(id);
function toast(m) { alert(m); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function fmtJson(v) { try { return JSON.stringify(v, null, 2); } catch { return String(v); } }
function parseJson(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }

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
  const resp = await fetch('./api/workflows', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wf)
  });
  const data = await resp.json();
  if (!data.ok) {
    toast('Save failed');
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
  if (!state.current?.id) { toast('Nothing selected'); return; }
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
  const wf = collectWorkflowFromForm();
  if (!wf.id) {
    toast('Please save the workflow before running.');
    return;
  }
  const vars = parseJson($('varsInput').value || '{}', {});
  const resp = await fetch(`./api/workflows/${wf.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ vars })
  });
  const data = await resp.json();
  renderRunResult(data);
  await loadRuns();
}

// Test selected step
async function testStep() {
  const wf = collectWorkflowFromForm();
  const step = wf.steps[state.currentStepIdx];
  if (!step) { toast('Select a step'); return; }
  const vars = parseJson($('varsInput').value || '{}', {});
  const resp = await fetch('./api/testStep', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat: wf.chat, step, vars })
  });
  const data = await resp.json();
  renderStepTestResult(data);
}

// Collect from form fields
function collectWorkflowFromForm() {
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
      const resp = await fetch(`./api/workflows/${w.id}`);
      const data = await resp.json();
      state.current = data.workflow;
      state.currentStepIdx = -1;
      renderWorkflowEditor();
      $('tabBtnBuilder').click();
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
  const resp = await fetch('./api/runs');
  const data = await resp.json();
  state.runs = data.runs || [];
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
      <pre class="log">${escapeHtml((data.raw || '').slice(0, 4000))}</pre>
      <h4>Artifacts (${data.artifacts?.length || 0})</h4>
      ${renderArtifacts(data.artifacts || [])}
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

// Wire up events
document.addEventListener('DOMContentLoaded', async () => {
  $('tabBtnBuilder').addEventListener('click', () => activateTab('builder'));
  $('tabBtnRuns').addEventListener('click', () => activateTab('runs'));
  $('newWfBtn').addEventListener('click', () => { state.current = newWorkflow(); state.currentStepIdx = -1; renderWorkflowEditor(); });
  $('saveWfBtn').addEventListener('click', saveCurrent);
  $('deleteWfBtn').addEventListener('click', deleteCurrent);
  $('addStepBtn').addEventListener('click', addStep);
  $('testStepBtn').addEventListener('click', testStep);
  $('runWfBtn').addEventListener('click', runCurrent);

  // Keep form changes in state for current step
  ['wfName','wfDesc','provider','baseUrl','apiKey','model','temperature','max_tokens','defaults',
   'stepName','stepPrompt','stepSchema','stepNoGuard','stepDontStop','stepExportPath','stepExportAs',
   'sProvider','sBaseUrl','sApiKey','sModel','sTemp'
  ].forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', () => collectWorkflowFromForm());
    if (el && el.tagName === 'TEXTAREA') el.addEventListener('input', () => collectWorkflowFromForm());
  });

  activateTab('builder');
  await loadWorkflows();
  await loadRuns();
});

// Minimal utils
function copyToClipboard(text) {
  navigator.clipboard?.writeText(text).then(() => toast('Copied'));
}

