// Local + server-backed storage for workflows
const LS_KEY = 'llmWorkflows';
export async function listWorkflows() {
  try {
    const r = await fetch('/api/workflows'); if (r.ok) return (await r.json())?.items || [];
  } catch {}
  const raw = localStorage.getItem(LS_KEY) || '[]';
  return JSON.parse(raw);
}
export async function saveWorkflow(wf) {
  // Persist server-first; fallback to localStorage
  try {
    const r = await fetch('/api/workflows', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ workflow: wf }) });
    if (r.ok) return (await r.json()).workflow;
  } catch {}
  const arr = await listWorkflows();
  const idx = arr.findIndex(x => x.id === wf.id);
  if (idx >= 0) arr[idx] = wf; else arr.push(wf);
  localStorage.setItem(LS_KEY, JSON.stringify(arr));
  return wf;
}
export async function deleteWorkflow(id) {
  try {
    await fetch(`/api/workflows/${encodeURIComponent(id)}`, { method:'DELETE' });
  } catch {}
  const arr = await listWorkflows();
  const next = arr.filter(x => x.id !== id);
  localStorage.setItem(LS_KEY, JSON.stringify(next));
  return true;
}
export async function getWorkflow(id) {
  try {
    const r = await fetch(`/api/workflows/${encodeURIComponent(id)}`); if (r.ok) return (await r.json()).workflow;
  } catch {}
  const arr = await listWorkflows();
  return arr.find(x => x.id === id) || null;
}
export function newWorkflowTemplate() {
  return {
    id: `wf_${Date.now()}_${Math.random().toString(36).slice(2,7)}`,
    name: 'New Workflow',
    description: '',
    autoExecuteActions: false,
    steps: [
      {
        id: `step_${Date.now().toString(36)}`,
        name: 'Step 1',
        system: 'You are a helpful agent. Return strictly valid JSON for the requested schema.',
        userTemplate: 'Analyze: {{input}}\nReturn actions to execute.',
        schema: 'actions.v1'
      }
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}