export async function listWorkflows(){
  const r = await fetch('./api/workflows');
  return await r.json();
}
export async function saveWorkflow(wf){
  const r = await fetch('./api/workflows', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(wf) });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
export async function deleteWorkflow(id){
  const r = await fetch(`./api/workflows/${encodeURIComponent(id)}`, { method:'DELETE' });
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}
export async function getWorkflow(id){
  const r = await fetch(`./api/workflows/${encodeURIComponent(id)}`);
  if (!r.ok) throw new Error(await r.text());
  return await r.json();
}

export async function testWorkflowStream({ id, input, overrides, dryRun, allowExecute }) {
  const r = await fetch(`./api/workflows/${encodeURIComponent(id)}/test/stream`, {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ input, overrides, dryRun, allowExecute })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.body; // ReadableStream
}

