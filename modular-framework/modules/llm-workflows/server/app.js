const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bodyParser = require('body-parser');
const Ajv = require('ajv');

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, ''); // e.g. /modules/llm-workflows
const LLM_CHAT_URL = process.env.LLM_CHAT_URL || 'http://localhost:3004/api/chat'; // llm-chat backend
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const WF_FILE = path.join(DATA_DIR, 'workflows.json');

ensureDir(DATA_DIR);
ensureFile(WF_FILE, JSON.stringify({ workflows: [] }, null, 2));

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));

// Static UI
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));
if (BASE_PATH) app.use(BASE_PATH, express.static(pub));

app.get('/', (_req, res) => res.sendFile(path.join(pub, 'index.html')));
if (BASE_PATH) app.get(`${BASE_PATH}/`, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

// Health
app.get('/health', (_req, res) => res.json({ status: 'healthy', chatUrl: LLM_CHAT_URL }));
if (BASE_PATH) app.get(`${BASE_PATH}/health`, (_req, res) => res.json({ status: 'healthy', chatUrl: LLM_CHAT_URL }));

// Storage helpers
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function ensureFile(p, initial) { if (!fs.existsSync(p)) fs.writeFileSync(p, initial); }
function readStore() {
  try {
    const raw = fs.readFileSync(WF_FILE, 'utf8');
    const obj = JSON.parse(raw || '{"workflows":[]}');
    if (!obj.workflows) obj.workflows = [];
    return obj;
  } catch {
    return { workflows: [] };
  }
}
function writeStore(obj) {
  fs.writeFileSync(WF_FILE, JSON.stringify(obj, null, 2));
}

function uuid() {
  return (global.crypto?.randomUUID?.() || require('crypto').randomUUID());
}

// In-memory run history (ring buffer)
const RUN_MAX = Number(process.env.RUN_MAX || 100);
const runs = []; // { id, workflowId, name, startedAt, finishedAt, status, logs[], artifacts[], outputByStep: {} }
function addRun(r) {
  runs.push(r);
  while (runs.length > RUN_MAX) runs.shift();
}

// JSON helpers
function tryParseJson(text) {
  // Try direct parse
  try { return JSON.parse(text); } catch {}
  // Try code fence ```json ... ```
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch {}
  }
  // Try to find first {...} block (naive)
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const maybe = text.slice(firstBrace, lastBrace + 1);
    try { return JSON.parse(maybe); } catch {}
  }
  return null;
}

// Templating
function renderTemplate(tpl, vars) {
  return (tpl || '').replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, (_m, k) => {
    const val = lookup(vars, k);
    return (val === undefined || val === null) ? '' : String(val);
  });
}
function lookup(obj, pathStr) {
  const parts = String(pathStr).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return cur;
}

// System prompt for JSON schema compliance
function buildSystemGuard(schema) {
  const schemaStr = typeof schema === 'string' ? schema : JSON.stringify(schema, null, 2);
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

// Validate JSON result against schema
const ajv = new Ajv({ allErrors: true, strict: false });
function validateAgainstSchema(json, schema) {
  try {
    const objSchema = typeof schema === 'string' ? JSON.parse(schema) : schema;
    const validate = ajv.compile(objSchema);
    const valid = validate(json);
    return { valid, errors: validate.errors || [] };
  } catch (e) {
    return { valid: false, errors: [{ message: 'Schema parse/compile error: ' + String(e.message || e) }] };
  }
}

// Call llm-chat backend
async function callChat({ provider, baseUrl, apiKey, model, temperature, max_tokens, messages }) {
  // We rely on llm-chat server to route to the correct provider. We send stream:false for simplicity.
  const resp = await axios.post(LLM_CHAT_URL, {
    provider, baseUrl, apiKey, model, messages, temperature, max_tokens, stream: false
  }, { timeout: 60_000 });
  const content = resp?.data?.content || '';
  return content;
}

// Engine: run a single step
async function runStep({ chatConfig, step, vars }) {
  const logs = [];
  function log(level, msg, meta) { logs.push({ ts: new Date().toISOString(), level, msg, meta }); }

  // Build system + user content
  const sys = step.systemGuard === false ? (step.system || '') : buildSystemGuard(step.schema || defaultActionSchema());
  const user = renderTemplate(step.prompt || '', vars || {});
  log('info', 'Prepared prompt', { user });

  // Call LLM
  const messages = [];
  if (sys) messages.push({ role: 'system', content: sys });
  messages.push({ role: 'user', content: user });

  const mergedChat = {
    provider: step.provider || chatConfig.provider,
    baseUrl: step.baseUrl || chatConfig.baseUrl,
    apiKey: step.apiKey || chatConfig.apiKey,
    model: step.model || chatConfig.model,
    temperature: typeof step.temperature === 'number' ? step.temperature : chatConfig.temperature,
    max_tokens: step.max_tokens || chatConfig.max_tokens
  };
  if (!mergedChat.baseUrl || !mergedChat.model || (!mergedChat.apiKey && (mergedChat.provider === 'openai' || mergedChat.provider === 'openai-compatible'))) {
    log('error', 'Chat config incomplete', { mergedChat });
    return { ok: false, logs, raw: '', json: null, validation: { valid: false, errors: [{ message: 'Chat configuration missing baseUrl/model/apiKey' }] } };
  }

  let raw = '';
  try {
    raw = await callChat({ ...mergedChat, messages });
    log('info', 'LLM returned', { length: raw.length });
  } catch (e) {
    log('error', 'LLM call failed', { message: e.message });
    return { ok: false, logs, raw, json: null, validation: { valid: false, errors: [{ message: 'LLM call failed: ' + e.message }] } };
  }

  // Parse JSON
  const parsed = tryParseJson(raw);
  if (!parsed) {
    log('error', 'Failed to parse JSON', { raw: raw.slice(0, 500) });
    return { ok: false, logs, raw, json: null, validation: { valid: false, errors: [{ message: 'JSON parse failed' }] } };
  }

  // Validate
  const validation = validateAgainstSchema(parsed, step.schema || defaultActionSchema());
  if (!validation.valid) {
    log('warn', 'Schema validation failed', { errors: validation.errors });
    return { ok: false, logs, raw, json: parsed, validation };
  }

  // Extract artifacts conventionally from parsed.actions
  const artifacts = [];
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    const type = a.type;
    if (['bash', 'python', 'sql', 'http', 'plan', 'text'].includes(type)) {
      artifacts.push({
        type,
        content: a.content || '',
        filename: a.filename || null,
        cwd: a.cwd || null,
        env: a.env || null,
        meta: a.meta || null
      });
    }
  }
  log('info', 'Extracted artifacts', { count: artifacts.length });

  return { ok: true, logs, raw, json: parsed, artifacts, validation };
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

// API: list workflows
app.get('/api/workflows', (_req, res) => {
  const { workflows } = readStore();
  res.json({ workflows });
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/workflows`, (req, res) => {
  const { workflows } = readStore();
  res.json({ workflows });
});

// API: get workflow
app.get('/api/workflows/:id', (req, res) => {
  const { id } = req.params;
  const { workflows } = readStore();
  const wf = workflows.find(w => w.id === id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json({ workflow: wf });
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/workflows/:id`, (req, res) => {
  const { id } = req.params;
  const { workflows } = readStore();
  const wf = workflows.find(w => w.id === id);
  if (!wf) return res.status(404).json({ error: 'Not found' });
  res.json({ workflow: wf });
});

// API: create/update workflow
app.post('/api/workflows', (req, res) => {
  const payload = req.body || {};
  const store = readStore();
  let wf = payload;
  if (!wf.id) wf.id = uuid();
  wf.updatedAt = new Date().toISOString();
  if (!wf.createdAt) wf.createdAt = wf.updatedAt;
  if (!Array.isArray(wf.steps)) wf.steps = [];
  if (!wf.chat) wf.chat = { provider: 'openai', baseUrl: '', apiKey: '', model: '', temperature: 0.2 };

  const idx = store.workflows.findIndex(x => x.id === wf.id);
  if (idx >= 0) store.workflows[idx] = wf; else store.workflows.push(wf);
  writeStore(store);
  res.json({ ok: true, id: wf.id, workflow: wf });
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/workflows`, (req, res) => {
  req.url = '/api/workflows';
  app._router.handle(req, res);
});

// API: delete workflow
app.delete('/api/workflows/:id', (req, res) => {
  const { id } = req.params;
  const store = readStore();
  const idx = store.workflows.findIndex(w => w.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  store.workflows.splice(idx, 1);
  writeStore(store);
  res.json({ ok: true });
});
if (BASE_PATH) app.delete(`${BASE_PATH}/api/workflows/:id`, (req, res) => {
  req.url = `/api/workflows/${req.params.id}`;
  app._router.handle(req, res);
});

// API: validate JSON against schema
app.post('/api/validate', (req, res) => {
  const { json, schema } = req.body || {};
  const result = validateAgainstSchema(json, schema || defaultActionSchema());
  res.json(result);
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/validate`, (req, res) => {
  req.url = '/api/validate';
  app._router.handle(req, res);
});

// API: test single step
app.post('/api/testStep', async (req, res) => {
  const { chat, step, vars } = req.body || {};
  try {
    const result = await runStep({ chatConfig: chat || {}, step: step || {}, vars: vars || {} });
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/testStep`, (req, res) => {
  req.url = '/api/testStep';
  app._router.handle(req, res);
});

// API: run a workflow
app.post('/api/workflows/:id/run', async (req, res) => {
  const { id } = req.params;
  const inputs = req.body?.vars || {};
  const store = readStore();
  const wf = store.workflows.find(w => w.id === id);
  if (!wf) return res.status(404).json({ error: 'Not found' });

  const run = {
    id: uuid(),
    workflowId: wf.id,
    name: wf.name || 'Workflow',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    logs: [],
    artifacts: [],
    outputByStep: {}
  };
  addRun(run);

  function runLog(level, msg, meta) { run.logs.push({ ts: new Date().toISOString(), level, msg, meta }); }

  try {
    const vars = { ...(wf.defaults || {}), ...(inputs || {}) };
    for (const step of (wf.steps || [])) {
      runLog('info', `Step start: ${step.name || step.id}`);
      const r = await runStep({ chatConfig: wf.chat || {}, step, vars });
      run.outputByStep[step.id || step.name || `step_${Math.random()}`] = {
        ok: r.ok, json: r.json, validation: r.validation, raw: r.raw, logs: r.logs
      };
      run.logs.push(...r.logs.map(l => ({ ...l, step: step.name || step.id })));
      if (r.artifacts?.length) {
        for (const a of r.artifacts) {
          run.artifacts.push({ step: step.name || step.id, ...a });
        }
      }
      // Update variables with any declared outputs (optional: map a field)
      if (step.exportPath && r.json) {
        try {
          const value = lookup(r.json, step.exportPath);
          if (value !== undefined) vars[step.exportAs || step.exportPath] = value;
        } catch {}
      }
      if (!r.ok) {
        runLog('warn', `Step failed: ${step.name || step.id}`);
        if (step.stopOnFailure !== false) {
          run.status = 'failed';
          run.finishedAt = new Date().toISOString();
          return res.json(run);
        }
      } else {
        runLog('info', `Step ok: ${step.name || step.id}`);
      }
    }
    run.status = 'ok';
    run.finishedAt = new Date().toISOString();
    res.json(run);
  } catch (e) {
    run.status = 'error';
    run.finishedAt = new Date().toISOString();
    runLog('error', 'Run error', { message: e.message });
    res.status(500).json(run);
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/workflows/:id/run`, (req, res) => {
  req.url = `/api/workflows/${req.params.id}/run`;
  app._router.handle(req, res);
});

// API: runs history
app.get('/api/runs', (_req, res) => {
  res.json({ runs });
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/runs`, (_req, res) => {
  res.json({ runs });
});


module.exports = app;

