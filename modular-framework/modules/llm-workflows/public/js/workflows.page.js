import { getGlobal, getProfiles, getActiveName } from './storage.js';
import { listWorkflows, saveWorkflow, deleteWorkflow, getWorkflow, newWorkflowTemplate } from './workflows.store.js';
import { WF_SCHEMAS, runWorkflow } from './workflows.run.js';

let current = null;

function el(id){ return document.getElementById(id); }
function profileToLlmConfig() {
  const g = getGlobal();
  const p = getProfiles().find(x => x.name === getActiveName()) || {};
  return {
    provider: p.provider ?? g.provider,
    baseUrl:  p.baseUrl  ?? g.baseUrl,
    apiKey:   p.apiKey   ?? g.apiKey,
    model:    p.model    ?? g.model,
    temperature: p.temperature ?? g.temperature,
    max_tokens: p.max_tokens ?? g.max_tokens
  };
}

function renderSchemaOptions(select, value) {
  select.innerHTML = '';
  Object.keys(WF_SCHEMAS).forEach(k => {
    const o = document.createElement('option'); o.value = k; o.textContent = `${k} – ${WF_SCHEMAS[k].name}`;
    if (k === value) o.selected = true;
    select.appendChild(o);
  });
}

function stepItem(step, idx) {
  const wrap = document.createElement('div'); wrap.className = 'wf-step';
  wrap.innerHTML = `
    <div class="wf-row">
      <div>
        <label>Step Name</label>
        <input class="s-name" value="${step.name || ''}" />
      </div>
      <div>
        <label>Schema</label>
        <select class="s-schema"></select>
      </div>
    </div>
    <label>System Prompt</label>
    <textarea class="s-system" rows="3">${step.system || ''}</textarea>
    <label>User Template (use {{var}})</label>
    <textarea class="s-user" rows="3">${step.userTemplate || ''}</textarea>
    <div class="wf-actions">
      <button class="ghost s-up">↑</button>
      <button class="ghost s-down">↓</button>
      <button class="danger s-del">Delete</button>
      <span class="badge">id: ${step.id}</span>
    </div>
  `;
  const schemaSel = wrap.querySelector('.s-schema');
  renderSchemaOptions(schemaSel, step.schema || 'actions.v1');

  wrap.querySelector('.s-name').addEventListener('input', (e)=> step.name = e.target.value);
  wrap.querySelector('.s-system').addEventListener('input', (e)=> step.system = e.target.value);
  wrap.querySelector('.s-user').addEventListener('input', (e)=> step.userTemplate = e.target.value);
  schemaSel.addEventListener('change', (e)=> step.schema = e.target.value);

  wrap.querySelector('.s-del').onclick = ()=> {
    current.steps.splice(idx,1); renderSteps();
  };
  wrap.querySelector('.s-up').onclick = ()=> {
    if (idx<=0) return;
    const t = current.steps[idx-1]; current.steps[idx-1]=current.steps[idx]; current.steps[idx]=t; renderSteps();
  };
  wrap.querySelector('.s-down').onclick = ()=> {
    if (idx>=current.steps.length-1) return;
    const t = current.steps[idx+1]; current.steps[idx+1]=current.steps[idx]; current.steps[idx]=t; renderSteps();
  };
  return wrap;
}

function renderSteps(){
  const container = el('wfSteps');
  container.innerHTML = '';
  current.steps.forEach((s, i)=> container.appendChild(stepItem(s, i)));
}

async function renderList(){
  const items = await listWorkflows();
  const list = el('wfList'); list.innerHTML='';
  items.forEach(wf=>{
    const div = document.createElement('div');
    div.className='item';
    div.innerHTML = `
      <div>
        <strong>${wf.name}</strong>
        <span class="pill">${wf.steps?.length||0} steps</span>
        <div class="muted">${wf.description || ''}</div>
      </div>
      <button class="ghost">Edit</button>
      <button class="danger">Delete</button>
    `;
    const [_, editBtn, delBtn] = div.children;
    editBtn.onclick = async ()=> { current = await getWorkflow(wf.id); renderEditor(); };
    delBtn.onclick = async ()=> { if(confirm('Delete workflow?')) { await deleteWorkflow(wf.id); if (current?.id===wf.id) current=null; renderList(); renderEditor(); } };
    list.appendChild(div);
  });
}

function renderEditor(){
  const name = el('wfName'), desc = el('wfDesc'), auto = el('wfAuto');
  if (!current) {
    name.value=''; desc.value=''; auto.checked=false;
    el('wfSteps').innerHTML = '<div class="muted">No workflow selected.</div>';
    return;
  }
  name.value = current.name || '';
  desc.value = current.description || '';
  auto.checked = !!current.autoExecuteActions;
  renderSteps();
}

function appendLog(msg){
  const log = el('wfLog');
  log.textContent += (msg.endsWith('\n') ? msg : (msg+'\n'));
  log.scrollTop = log.scrollHeight;
}

async function onRun(){
  if (!current) return alert('Select or create a workflow first.');
  const input = el('wfInput').value.trim();
  const vars = input ? { input } : {};
  const llmConfig = profileToLlmConfig();
  el('wfLog').textContent = '';
  appendLog(`Using profile: ${getActiveName()} (${llmConfig.model})`);
  const res = await runWorkflow({
    workflow: current,
    inputVars: vars,
    llmConfig,
    logFn: appendLog
  });
  if (!res.ok) appendLog(`\n[FAILED] ${res.error}`);
  else appendLog(`\n[OK] Final variables: ${JSON.stringify(res.variables, null, 2)}`);
}

export async function initWorkflowsUI(){
  el('wfNew').onclick = async () => { current = newWorkflowTemplate(); await saveWorkflow(current); renderList(); renderEditor(); };
  el('wfAddStep').onclick = ()=> {
    if (!current) return alert('Create/select a workflow first.');
    current.steps.push({
      id: `step_${Date.now().toString(36)}`,
      name: `Step ${current.steps.length+1}`,
      system: 'Return strict JSON only.',
      userTemplate: 'Task: {{input}}',
      schema: 'actions.v1'
    });
    renderSteps();
  };
  el('wfSave').onclick = async ()=>{
    if (!current) return;
    current.name = el('wfName').value.trim() || current.name;
    current.description = el('wfDesc').value.trim();
    current.autoExecuteActions = el('wfAuto').checked;
    current.updatedAt = new Date().toISOString();
    await saveWorkflow(current);
    renderList();
    alert('Saved');
  };
  el('wfRun').onclick = onRun;
  await renderList();
  renderEditor();
}