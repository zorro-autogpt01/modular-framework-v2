import { parseStream } from './sse.js';

// Standard schemas for strict JSON answers
export const WF_SCHEMAS = {
  'actions.v1': {
    name: 'Executable Actions v1',
    description: 'LLM returns concrete actions to execute (bash/python) with optional variables.',
    jsonSchema: `{
  "summary": "string (short summary of what will be done)",
  "variables": { "type": "object", "description": "Any key/value pairs to pass to next steps" },
  "actions": [
    {
      "kind": "bash | python",
      "label": "human readable title",
      "code": "command/script text",
      "cwd": "optional working directory",
      "timeoutSec": "optional number (default=60)"
    }
  ]
}`
  }
};

// Build guardrails for strict JSON-only responses
function buildJsonGuard(schemaText) {
  return `
You must answer with STRICT JSON ONLY. Do not include markdown, backticks, comments, or any text before/after the JSON.
The JSON must follow this schema conceptually:
${schemaText}

Rules:
- If unsure, leave fields empty or use empty arrays/objects.
- Never include explanations outside JSON.
If you cannot comply, return: {"summary":"error","variables":{},"actions":[]}
`.trim();
}

export async function callLLM({ baseUrl, provider, apiKey, model, temperature, max_tokens, messages, stream=false }) {
  const body = { baseUrl, provider, apiKey, model, messages, temperature, max_tokens, stream };
  const resp = await fetch(`${detectBasePath()}api/chat`, {
    method:'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(await resp.text() || 'LLM HTTP error');
  if (!stream) return await resp.json(); // { content }
  // Stream and accumulate
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = parseStream(
    (d)=> text += d,
    ()=>{},
    (m)=> { text += `\n[error] ${m}`; }
  );
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    pump(decoder.decode(value, { stream:true }));
  }
  return { content: text };
}

function detectBasePath() {
  const p = window.location.pathname;
  const base = p.replace(/\/config\/?$/, '/');
  return base.endsWith('/') ? base : (base + '/');
}

export async function runLLMStep({ step, vars, llmConfig, logFn, maxRetries=2 }) {
  const schema = WF_SCHEMAS[step.schema] || WF_SCHEMAS['actions.v1'];
  const sys = `${step.system || ''}\n\n${buildJsonGuard(schema.jsonSchema)}`;
  const user = (step.userTemplate || '').replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''));
  const messages = [{ role:'system', content: sys }, { role:'user', content: user }];

  for (let attempt=0; attempt<=maxRetries; attempt++) {
    logFn?.(`→ LLM request (attempt ${attempt+1})`);
    const { content } = await callLLM({ ...llmConfig, messages, stream:true });
    const trimmed = (content || '').trim();

    // Try to extract JSON (tolerate extra text if model misbehaves)
    const json = extractFirstJson(trimmed);
    if (!json.ok) {
      logFn?.(`LLM JSON parse failed: ${json.error}`);
      // Feed back correction
      messages.push({ role:'assistant', content: trimmed });
      messages.push({ role:'user', content: `Your previous reply was not valid JSON. Error: ${json.error}. Respond again with STRICT JSON only.` });
      continue;
    }

    // Validate minimal shape
    const data = json.value;
    if (!Array.isArray(data.actions)) data.actions = [];
    if (!data.variables || typeof data.variables !== 'object') data.variables = {};
    if (typeof data.summary !== 'string') data.summary = '';

    logFn?.(`✓ JSON received: summary="${data.summary}" actions=${data.actions.length}`);
    return { ok:true, data };
  }

  return { ok:false, error:'Failed to obtain valid JSON from LLM after retries' };
}

// Extract the first JSON object/array from text
function extractFirstJson(text) {
  try {
    // Fast path: pure JSON
    return { ok:true, value: JSON.parse(text) };
  } catch {}
  // Fallback: find first { ... } or [ ... ]
  const start = text.indexOf('{') >= 0 ? text.indexOf('{') : text.indexOf('[');
  if (start === -1) return { ok:false, error:'No JSON start found' };
  for (let end = text.length; end > start; end--) {
    const slice = text.slice(start, end);
    try {
      const v = JSON.parse(slice);
      return { ok:true, value: v };
    } catch {}
  }
  return { ok:false, error:'Unable to parse embedded JSON' };
}

export async function maybeExecuteActions(actions, { autoExecute, logFn }) {
  const results = [];
  for (const a of actions) {
    const kind = String(a.kind || '').toLowerCase();
    if (!['bash','python'].includes(kind)) {
      logFn?.(`↷ Skip action kind="${a.kind}" (unsupported)`);
      results.push({ kind:a.kind, skipped:true, reason:'unsupported kind' });
      continue;
    }
    if (!autoExecute) {
      logFn?.(`◻ Dry-run: ${a.label || kind} (will not execute)`);
      results.push({ kind:a.kind, dryRun:true });
      continue;
    }
    logFn?.(`▶ Executing ${kind}: ${a.label || ''}`);
    const r = await fetch('/api/agent/execute', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        kind,
        code: a.code || '',
        cwd: a.cwd || '',
        timeoutSec: Math.min(Number(a.timeoutSec || 60), 300)
      })
    });
    const data = await r.json();
    const ok = r.ok && data?.ok;
    logFn?.(`${ok?'✓':'✗'} Exit ${data.exitCode}; stdout:\n${(data.stdout||'').slice(0,4000)}\n--- stderr:\n${(data.stderr||'').slice(0,4000)}`);
    results.push({ ...data, requested: a });
  }
  return results;
}

export async function runWorkflow({ workflow, inputVars, llmConfig, logFn }) {
  let vars = { ...(inputVars||{}) };
  logFn?.(`Workflow "${workflow.name}" started. Steps=${workflow.steps.length}`);
  for (let i=0; i<workflow.steps.length; i++) {
    const step = workflow.steps[i];
    logFn?.(`\n# Step ${i+1}: ${step.name}`);
    const r = await runLLMStep({ step, vars, llmConfig, logFn });

    if (!r.ok) { logFn?.(`Step failed: ${r.error}`); return { ok:false, error:r.error }; }

    // merge variables for next step
    vars = { ...vars, ...(r.data.variables || {}) };

    // execute actions (maybe)
    const exec = await maybeExecuteActions(r.data.actions || [], { autoExecute: !!workflow.autoExecuteActions, logFn });
    // Collect per step? Keep it simple and log only
  }
  logFn?.(`\nWorkflow finished.`);
  return { ok:true, variables: vars };
}
