// app.js - Fully integrated with llm-gateway
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const bodyParser = require('body-parser');
const Ajv = require('ajv');

const { router: logsRouter } = require('./routes/logs');
const { router: loggingRouter } = require('./routes/logging');
const { execBash, execPython, sanitizeCwd } = require('./executor');
const { stamp, logDebug, logInfo, logWarn, logError } = require('./logger');
const {
  listRunners, getRunner, pingRunner, execRemote,
  upsertRunner, removeRunner
} = require('./runnerClient');

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, '');
const ALLOW_STEP_EXEC = String(process.env.ALLOW_STEP_EXEC || 'false').toLowerCase() === 'true';

function trimSlash(s) { return String(s || '').replace(/\/+$/, ''); }

const DEFAULT_GW_API = 'http://llm-gateway:3010/api';

// Use the workflows-compatible endpoint
const LLM_GATEWAY_CHAT_URL = trimSlash(
  process.env.LLM_GATEWAY_URL ||
  process.env.LLM_GATEWAY_CHAT_URL ||
  `${DEFAULT_GW_API}/compat/llm-workflows`
);

const LLM_GATEWAY_API_BASE = trimSlash(
  process.env.LLM_GATEWAY_API_BASE ||
  (LLM_GATEWAY_CHAT_URL.replace(/\/compat\/[^/]+(?:\/)?$/, '') || DEFAULT_GW_API)
);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const WF_FILE = path.join(DATA_DIR, 'workflows.json');
const RUNNERS_FILE = path.join(DATA_DIR, 'runners.json');

ensureDir(DATA_DIR);
ensureFile(WF_FILE, JSON.stringify({ workflows: [] }, null, 2));
ensureFile(RUNNERS_FILE, JSON.stringify({ runners: [] }, null, 2));

function seedRunnersFromFile() {
  try {
    const raw = fs.readFileSync(RUNNERS_FILE, 'utf8');
    const obj = JSON.parse(raw || '{}');
    const items = Array.isArray(obj?.runners) ? obj.runners : [];
    let count = 0;
    for (const r of items) {
      if (!r || typeof r !== 'object') continue;
      const { name, url, token, default_cwd } = r;
      if (name && url && token) {
        upsertRunner({ name, url, token, default_cwd });
        count++;
      }
    }
    logInfo('runners_seeded', { count });
  } catch (e) {
    logWarn('runners_seed_failed', { message: e.message });
  }
}
seedRunnersFromFile();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));
app.use(stamp);

// HTTP access logging
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    logInfo('http_access', {
      rid: req.id,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      duration_ms: Math.round(durMs),
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
      ua: req.headers['user-agent'] || ''
    });
  });
  next();
});

// Internal auth middleware
function requireInternalAuth(req, res, next) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return next();
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${token}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function requireRunnerRegToken(req, res, next) {
  const t = process.env.RUNNER_REG_TOKEN;
  if (!t) return res.status(503).json({ error: 'registration disabled' });
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${t}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// Static UI
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));

// Log routes
app.use('/api', logsRouter);
app.use('/api', loggingRouter);

if (BASE_PATH) {
  app.use(BASE_PATH, express.static(pub));
  app.use(`${BASE_PATH}/api`, logsRouter);
  app.use(`${BASE_PATH}/api`, loggingRouter);
}

app.get('/', (_req, res) => res.sendFile(path.join(pub, 'index.html')));
if (BASE_PATH) app.get(`${BASE_PATH}/`, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

// Health
app.get('/health', (_req, res) =>
  res.json({
    status: 'healthy',
    gatewayChatUrl: LLM_GATEWAY_CHAT_URL,
    gatewayApiBase: LLM_GATEWAY_API_BASE,
    allowStepExec: ALLOW_STEP_EXEC,
    features: {
      telemetry: true,
      templates: true,
      costTracking: true,
      replay: true,
      dryRun: true
    }
  })
);
if (BASE_PATH)
  app.get(`${BASE_PATH}/health`, (_req, res) =>
    res.json({
      status: 'healthy',
      gatewayChatUrl: LLM_GATEWAY_CHAT_URL,
      gatewayApiBase: LLM_GATEWAY_API_BASE,
      allowStepExec: ALLOW_STEP_EXEC
    })
  );

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

// In-memory run history
const RUN_MAX = Number(process.env.RUN_MAX || 100);
const runs = [];
function addRun(r) {
  runs.push(r);
  while (runs.length > RUN_MAX) runs.shift();
}

// Template helpers
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

// Schema handling
const BUILTIN_SCHEMAS = { 'actions.v1': defaultActionSchema() };
function resolveSchema(schemaLike) {
  if (!schemaLike) return defaultActionSchema();
  if (typeof schemaLike === 'string') {
    try { return JSON.parse(schemaLike); } catch { /* not JSON text */ }
    return BUILTIN_SCHEMAS[schemaLike] || defaultActionSchema();
  }
  return schemaLike;
}

function buildSystemGuard(schema) {
  const schemaObj = resolveSchema(schema);
  const schemaStr = JSON.stringify(schemaObj, null, 2);
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

// Validate JSON
const ajv = new Ajv({ allErrors: true, strict: false });
function validateAgainstSchema(json, schema) {
  try {
    const objSchema = resolveSchema(schema);
    const validate = ajv.compile(objSchema);
    const valid = validate(json);
    return { valid, errors: validate.errors || [] };
  } catch (e) {
    return { valid: false, errors: [{ message: 'Schema parse/compile error: ' + String(e.message || e) }] };
  }
}

// JSON parsing helpers
function tryParseJson(text) {
  if (text == null) return null;
  const s = String(text).trim();

  try {
    const once = JSON.parse(s);
    if (typeof once === 'string') {
      try { return JSON.parse(once); } catch {}
    }
    return once;
  } catch {}

  const m = s.match(/```json\s*([\s\S]*?)```/i);
  if (m) {
    try {
      const once = JSON.parse(m[1]);
      if (typeof once === 'string') { try { return JSON.parse(once); } catch {} }
      return once;
    } catch {}
  }

  const blocks = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  for (const b of blocks) {
    try {
      const once = JSON.parse(b);
      if (typeof once === 'string') { try { return JSON.parse(once); } catch {} }
      return once;
    } catch {}
  }

  return null;
}

function firstDefined(...vals) {
  for (const v of vals) if (v !== undefined && v !== null) return v;
  return undefined;
}

function pickContentFromGateway(data) {
  if (typeof data === 'string') return data;

  let content = firstDefined(
    data?.content,
    data?.message?.content,
    data?.text
  );

  if (!content) content = data?.choices?.[0]?.message?.content;

  if (!content && Array.isArray(data?.output_text) && data.output_text[0]?.content) {
    content = data.output_text[0].content;
  }

  if (!content && Array.isArray(data?.output)) {
    const msg = data.output.find(p => p?.type === 'message');
    const parts = msg?.content;
    if (Array.isArray(parts)) {
      const ot = parts.find(p => p?.type === 'output_text' && typeof p?.text === 'string');
      if (ot?.text) content = ot.text;
      else if (typeof parts[0]?.text === 'string') content = parts[0].text;
      else if (typeof parts[0]?.content === 'string') content = parts[0].content;
    }
  }

  if (!content && data && typeof data === 'object' && data.raw) {
    const fromRaw = pickContentFromGateway(data.raw);
    if (fromRaw) return fromRaw;
  }

  if (!content && typeof data === 'object') {
    const maybe = firstDefined(
      data?.data?.content,
      data?.data?.message?.content
    );
    if (maybe) content = maybe;
  }

  return typeof content === 'string' ? content : '';
}

// **ENHANCED**: Gateway call with conversation tracking and metadata
async function callgateway({ model, temperature, max_tokens, messages, corr, ctx, metadata }) {
  const url = LLM_GATEWAY_CHAT_URL;
  const body = { 
    model, 
    messages, 
    stream: false,
    metadata: {
      ...(metadata || {}),
      workflows_correlation_id: corr,
      workflows_context: ctx
    }
  };
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof max_tokens === 'number') body.max_tokens = max_tokens;

  logInfo('WF -> GW POST', { 
    ctx, 
    corr, 
    url, 
    model, 
    temperature, 
    max_tokens, 
    messagesCount: Array.isArray(messages) ? messages.length : 0,
    hasMetadata: !!metadata
  });

  try {
    const resp = await axios.post(url, body, { timeout: 60_000 });
    const rawData = resp?.data;
    let content = pickContentFromGateway(rawData) ?? '';

    if (!content && rawData && typeof rawData === 'object') {
      try { content = JSON.stringify(rawData); } catch {}
    }

    logInfo('WF <- GW response', {
      ctx, corr,
      status: resp.status,
      contentLen: String(content || '').length,
      contentHead: String(content || '').slice(0, 500)
    });

    return content || '';
  } catch (e) {
    const status = e?.response?.status;
    const dataText = typeof e?.response?.data === 'string' ? e.response.data : JSON.stringify(e?.response?.data);
    logError('WF <- GW error', { ctx, corr, status, message: e.message, dataHead: (dataText || '').slice(0, 1000) });
    throw e;
  }
}

// **ENHANCED**: Run step with conversation tracking
async function runStep({ chatConfig, step, vars, ctx = 'runStep', corr, conversationId, workflowId, stepIndex }) {
  const logs = [];
  function log(level, msg, meta) {
    const entry = { ts: new Date().toISOString(), level, msg, meta };
    logs.push(entry);
    const base = { 
      ctx, 
      corr, 
      conversationId,
      workflowId,
      stepIndex,
      stepId: step?.id || null, 
      stepName: step?.name || null, 
      model: step?.model || chatConfig?.model || null, 
      ...(meta || {}) 
    };
    if (level === 'debug') logDebug(msg, base);
    else if (level === 'info') logInfo(msg, base);
    else if (level === 'warn') logWarn(msg, base);
    else if (level === 'error') logError(msg, base);
  }

  const effectiveSchema = resolveSchema(step.schema || defaultActionSchema());
  const sys = step.systemGuard === false ? (step.system || '') : buildSystemGuard(effectiveSchema);
  const user = renderTemplate(step.prompt || '', vars || {});
  
  log('info', 'Prepared prompt', {
    systemPreview: sys.slice(0, 800),
    userPreview: user.slice(0, 800)
  });

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

  if (/^(gpt-5|o5)/i.test(mergedChat.model || '')) {
    delete mergedChat.max_tokens;
    delete mergedChat.temperature;
  }

  const redacted = { ...mergedChat, apiKey: mergedChat.apiKey ? '***REDACTED***' : undefined };
  log('debug', 'Merged chat config', redacted);

  if (!mergedChat.model) {
    log('error', 'Chat config incomplete: missing model');
    return { 
      ok: false, 
      logs, 
      raw: '', 
      json: null, 
      validation: { valid: false, errors: [{ message: 'Model is required' }] } 
    };
  }

  let raw = '';
  try {
    raw = await callgateway({ 
      model: mergedChat.model, 
      temperature: mergedChat.temperature, 
      max_tokens: mergedChat.max_tokens, 
      messages, 
      corr, 
      ctx,
      metadata: {
        conversation_id: conversationId,
        workflow_id: workflowId,
        step_index: stepIndex,
        step_id: step?.id,
        step_name: step?.name
      }
    });
    log('info', 'LLM returned', { length: raw.length, head: raw.slice(0, 200) });
    if (!raw.length) log('warn', 'LLM response was empty', { length: 0 });
  } catch (e) {
    log('error', 'LLM call failed', { message: e.message });
    return { 
      ok: false, 
      logs, 
      raw, 
      json: null, 
      validation: { valid: false, errors: [{ message: 'LLM call failed: ' + e.message }] } 
    };
  }

  const parsed = tryParseJson(raw);
  if (!parsed) {
    log('error', 'Failed to parse JSON', { rawHead: raw.slice(0, 500), length: raw.length });
    return { 
      ok: false, 
      logs, 
      raw, 
      json: null, 
      validation: { valid: false, errors: [{ message: 'JSON parse failed' }] } 
    };
  }

  const validation = validateAgainstSchema(parsed, effectiveSchema);
  if (!validation.valid) {
    log('warn', 'Schema validation failed', { errorCount: (validation.errors || []).length });
    return { ok: false, logs, raw, json: parsed, validation };
  }

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

// --- Runner APIs ---
app.get('/api/runners', async (_req, res) => {
  try {
    const items = await listRunners();
    res.json({ runners: items });
  } catch {
    res.json({ runners: [] });
  }
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/runners`, (req, res) => {
  req.url = '/api/runners';
  app._router.handle(req, res);
});

app.get('/api/runners/:name/health', requireInternalAuth, async (req, res) => {
  const { name } = req.params;
  const r = await pingRunner(name);
  if (!r.ok) return res.status(502).json(r);
  res.json(r);
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/runners/:name/health`, (req, res) => {
  req.url = `/api/runners/${req.params.name}/health`;
  app._router.handle(req, res);
});

app.post('/api/runners', requireInternalAuth, (req, res) => {
  const { name, url, token, default_cwd } = req.body || {};
  if (!name || !url || !token) return res.status(400).json({ ok: false, error: 'name, url, token required' });
  try {
    const r = upsertRunner({ name, url, token, default_cwd });
    return res.json({ ok: true, runner: { name: r.name, url: r.url, default_cwd: r.default_cwd } });
  } catch (e) {
    logError('runner_upsert_error', { message: e.message });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/runners`, (req, res) => {
  req.url = '/api/runners';
  app._router.handle(req, res);
});

app.post('/api/runners/reload', requireInternalAuth, (req, res) => {
  try {
    seedRunnersFromFile();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'reload failed' });
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/runners/reload`, (req, res) => {
  req.url = '/api/runners/reload';
  app._router.handle(req, res);
});

app.delete('/api/runners/:name', requireInternalAuth, (req, res) => {
  try {
    removeRunner(req.params.name);
    return res.json({ ok: true });
  } catch (e) {
    logError('runner_delete_error', { message: e.message });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
if (BASE_PATH) app.delete(`${BASE_PATH}/api/runners/:name`, (req, res) => {
  req.url = `/api/runners/${req.params.name}`;
  app._router.handle(req, res);
});

app.post('/api/runners/register', requireRunnerRegToken, (req, res) => {
  const { name, url, token, default_cwd } = req.body || {};
  if (!name || !url || !token) return res.status(400).json({ ok: false, error: 'name, url, token required' });
  try {
    const r = upsertRunner({ name, url, token, default_cwd });
    return res.json({ ok: true, runner: { name: r.name, url: r.url, default_cwd: r.default_cwd } });
  } catch (e) {
    logError('runner_register_error', { message: e.message });
    return res.status(500).json({ error: 'Internal Server Error' });
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/runners/register`, (req, res) => {
  req.url = '/api/runners/register';
  app._router.handle(req, res);
});

// Runner installer
app.get('/install/runner.sh', (_req, res) => {
  const REG_TOKEN = process.env.RUNNER_REG_TOKEN || '';
  res.setHeader('Content-Type', 'text/x-shellscript');
  const script = `#!/usr/bin/env bash
set -euo pipefail

RUNNER_NAME=""
SERVER_BASE=""
RUNNER_URL=""
RUNNER_PORT="4010"
RUNNER_TOKEN=""
BASE_DIR="/tmp/runner-agent"
ALLOW_ENV=""
RUNNER_IMAGE="ghcr.io/modular-framework/runner-agent:latest"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) RUNNER_NAME="$2"; shift 2;;
    --server) SERVER_BASE="$2"; shift 2;;
    --runner-url) RUNNER_URL="$2"; shift 2;;
    --port) RUNNER_PORT="$2"; shift 2;;
    --token) RUNNER_TOKEN="$2"; shift 2;;
    --base-dir) BASE_DIR="$2"; shift 2;;
    --allow-env) ALLOW_ENV="$2"; shift 2;;
    --image) RUNNER_IMAGE="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required." >&2
  exit 1
fi

if [[ -z "\${RUNNER_NAME}" ]]; then
  RUNNER_NAME="agent-$(hostname)-$(date +%s)"
fi
if [[ -z "\${RUNNER_TOKEN}" ]]; then
  RUNNER_TOKEN="$(tr -dc A-Za-z0-9 </dev/urandom | head -c 24)"
fi
if [[ -z "\${SERVER_BASE}" ]]; then
  echo "Missing --server" >&2
  exit 1
fi
if [[ -z "\${RUNNER_URL}" ]]; then
  RUNNER_URL="http://localhost:\${RUNNER_PORT}"
fi

echo ">>> Starting runner: \${RUNNER_NAME} on port \${RUNNER_PORT}"
mkdir -p "\${BASE_DIR}"

if docker ps -a --format '{{.Names}}' | grep -q "^runner-agent-\${RUNNER_NAME}\$"; then
  docker rm -f "runner-agent-\${RUNNER_NAME}" >/dev/null 2>&1 || true
fi

docker run -d --name "runner-agent-\${RUNNER_NAME}" --restart unless-stopped \\
  -p "\${RUNNER_PORT}:4010" \\
  -e RUNNER_TOKEN="\${RUNNER_TOKEN}" \\
  -e RUNNER_BASE_DIR="\${BASE_DIR}" \\
  -e RUNNER_DEFAULT_TIMEOUT_MS="30000" \\
  -e RUNNER_ALLOW_ENV="\${ALLOW_ENV}" \\
  -v "\${BASE_DIR}:\${BASE_DIR}" \\
  "\${RUNNER_IMAGE}"

echo ">>> Waiting for health..."
for i in $(seq 1 30); do
  if curl -fsS -H "Authorization: Bearer \${RUNNER_TOKEN}" "\${RUNNER_URL}/health" >/dev/null 2>&1; then
    echo "Runner healthy."
    break
  fi
  sleep 1
  if [[ "$i" == "30" ]]; then
    echo "Runner did not become healthy in time." >&2
    exit 1
  fi
done

echo ">>> Registering runner..."
curl -fsS -X POST \\
  -H "Authorization: Bearer ${REG_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "'"'\${RUNNER_NAME}'"'",
    "url": "'"'\${RUNNER_URL}'"'",
    "token": "'"'\${RUNNER_TOKEN}'"'",
    "default_cwd": "'"'\${BASE_DIR}'"'"
  }' "\${SERVER_BASE}/api/v1/workflows/api/runners/register"

echo ">>> Done."
`;
  res.send(script);
});
if (BASE_PATH) app.get(`${BASE_PATH}/install/runner.sh`, (req, res) => {
  req.url = '/install/runner.sh';
  app._router.handle(req, res);
});

// --- Workflow APIs ---
app.get('/api/workflows', (_req, res) => {
  const { workflows } = readStore();
  res.json({ workflows });
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/workflows`, (req, res) => {
  const { workflows } = readStore();
  res.json({ workflows });
});

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

app.post('/api/validate', (req, res) => {
  const { json, schema } = req.body || {};
  const result = validateAgainstSchema(json, schema || defaultActionSchema());
  res.json(result);
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/validate`, (req, res) => {
  req.url = '/api/validate';
  app._router.handle(req, res);
});

// **NEW**: Gateway models proxy
app.get('/api/llm-models', async (_req, res) => {
  const url = `${LLM_GATEWAY_API_BASE}/models`;
  logInfo('WF -> GW GET models', { url });
  try {
    const r = await axios.get(url);
    logInfo('WF <- GW models', { status: r.status, count: (r.data?.items || []).length });
    res.json(r.data);
  } catch (e) {
    logError('WF <- GW models error', { message: e.message });
    res.status(502).json({ error: 'Failed to fetch models from gateway', detail: e.message });
  }
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/llm-models`, (req, res) => {
  req.url = '/api/llm-models';
  app._router.handle(req, res);
});

// **NEW**: Gateway templates proxy
app.get('/api/llm-templates', async (_req, res) => {
  const url = `${LLM_GATEWAY_API_BASE}/templates`;
  try {
    const r = await axios.get(url);
    res.json(r.data);
  } catch (e) {
    logError('WF <- GW templates error', { message: e.message });
    res.status(502).json({ error: 'Failed to fetch templates', detail: e.message });
  }
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/llm-templates`, (req, res) => {
  req.url = '/api/llm-templates';
  app._router.handle(req, res);
});

// **NEW**: Gateway telemetry proxy
app.get('/api/gateway/telemetry', async (req, res) => {
  const url = `${LLM_GATEWAY_API_BASE}/telemetry/recent?limit=${req.query.limit || 50}`;
  try {
    const r = await axios.get(url);
    res.json(r.data);
  } catch (e) {
    logError('WF <- GW telemetry error', { message: e.message });
    res.status(502).json({ error: 'Failed to fetch telemetry', detail: e.message });
  }
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/gateway/telemetry`, (req, res) => {
  req.url = '/api/gateway/telemetry';
  app._router.handle(req, res);
});

// **NEW**: Get workflow cost from gateway usage logs
app.get('/api/workflows/:id/cost', async (req, res) => {
  const { id } = req.params;
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  
  try {
    const url = `${LLM_GATEWAY_API_BASE}/usage?limit=${limit}`;
    const r = await axios.get(url);
    const items = r.data?.items || [];
    
    // Filter by workflow_id in metadata
    const relevant = items.filter(item => 
      item.meta?.workflow_id === id || 
      item.meta?.metadata?.workflow_id === id
    );
    
    const totalCost = relevant.reduce((sum, item) => sum + (Number(item.cost) || 0), 0);
    const totalInputTokens = relevant.reduce((sum, item) => sum + (Number(item.input_tokens) || 0), 0);
    const totalOutputTokens = relevant.reduce((sum, item) => sum + (Number(item.output_tokens) || 0), 0);
    
    res.json({
      workflow_id: id,
      usage_records: relevant.length,
      total_cost: totalCost,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      currency: relevant[0]?.meta?.currency || 'USD',
      records: relevant
    });
  } catch (e) {
    logError('WF cost query failed', { workflow_id: id, error: e.message });
    res.status(502).json({ error: 'Failed to fetch cost data', detail: e.message });
  }
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/workflows/:id/cost`, (req, res) => {
  req.url = `/api/workflows/${req.params.id}/cost`;
  app._router.handle(req, res);
});

// **ENHANCED**: Test step with dry-run support
app.post('/api/testStep', requireInternalAuth, async (req, res) => {
  const { chat, step, vars, execute = false, dryRun = false } = req.body || {};
  const corr = `test_${uuid()}`;
  const conversationId = `test_conv_${uuid()}`;
  
  try {
    logInfo('WF TEST_STEP start', { 
      corr, 
      conversationId,
      ip: req.ip, 
      model: step?.model || chat?.model, 
      stepId: step?.id || null, 
      hasVars: !!vars, 
      execute, 
      dryRun,
      allowExec: ALLOW_STEP_EXEC 
    });

    // **NEW**: Support dry-run mode
    if (dryRun) {
      // Just validate the step without calling LLM
      const schema = resolveSchema(step.schema || defaultActionSchema());
      return res.json({
        ok: true,
        dryRun: true,
        validated: true,
        step: {
          id: step.id,
          name: step.name,
          model: step.model || chat.model,
          schema: schema
        },
        message: 'Dry-run: validation passed, no LLM call made'
      });
    }

    const result = await runStep({ 
      chatConfig: chat || {}, 
      step: step || {}, 
      vars: vars || {}, 
      ctx: 'testStep', 
      corr,
      conversationId,
      workflowId: 'test',
      stepIndex: 0
    });

    if (execute && !ALLOW_STEP_EXEC) {
      result.actionResults = [{ 
        skipped: true, 
        reason: 'step execution disabled by server (ALLOW_STEP_EXEC=false)' 
      }];
      logWarn('WF TEST_STEP exec blocked', { corr });
      return res.json({ ok: true, ...result, execBlocked: true });
    }

    if (execute && result.ok && Array.isArray(result.json?.actions)) {
      const actionResults = [];
      const defaultTarget = step.target || step.runner || null;

      for (const [i, a] of result.json.actions.entries()) {
        if (!a || typeof a !== 'object') continue;
        const kind = String(a.type || a.kind || '').toLowerCase();
        const code = a.content || a.code || '';
        const cwd = sanitizeCwd(a.cwd || '');
        const timeoutMs = Math.min(Number(a.timeoutSec || 20000), 300000);
        const target = (a.meta && a.meta.target) ? String(a.meta.target) : defaultTarget;

        if (!['bash', 'python'].includes(kind)) {
          actionResults.push({ index: i, kind, skipped: true, reason: 'unsupported kind' });
          continue;
        }

        try {
          if (target && getRunner(target)) {
            const rmt = await execRemote({ target, kind, code, cwd, env: a.env, timeoutMs });
            actionResults.push({ 
              index: i, 
              kind, 
              target, 
              exitCode: rmt.exitCode, 
              killed: rmt.killed, 
              stdout: rmt.stdout, 
              stderr: rmt.stderr 
            });
          } else {
            if (kind === 'bash') {
              let out = '', err = '';
              const r = await execBash({ cmd: code, cwd, env: a.env, timeoutMs }, s => out += s, s => err += s);
              actionResults.push({ 
                index: i, 
                kind, 
                target: 'local', 
                exitCode: r.code, 
                killed: r.killed, 
                stdout: out, 
                stderr: err 
              });
            } else {
              let out = '', err = '';
              const r = await execPython({ script: code, cwd, env: a.env, timeoutMs }, s => out += s, s => err += s);
              actionResults.push({ 
                index: i, 
                kind, 
                target: 'local', 
                exitCode: r.code, 
                killed: r.killed, 
                stdout: out, 
                stderr: err 
              });
            }
          }
        } catch (e) {
          actionResults.push({ 
            index: i, 
            kind, 
            target: target || 'local', 
            error: String(e.message || e) 
          });
        }
      }
      result.actionResults = actionResults;
    }

    logInfo('WF TEST_STEP result', { 
      corr, 
      conversationId,
      ok: !!result.ok, 
      rawLen: (result.raw || '').length, 
      hasJson: !!result.json, 
      validationErrors: (result.validation?.errors || []).length, 
      artifacts: (result.artifacts || []).length 
    });
    
    res.json(result);
  } catch (e) {
    logError('WF TEST_STEP error', { corr, conversationId, message: e.message });
    res.status(500).json({ ok: false, error: e.message });
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/testStep`, (req, res) => {
  req.url = '/api/testStep';
  app._router.handle(req, res);
});

// **ENHANCED**: Run workflow with full gateway integration
app.post('/api/workflows/:id/run', requireInternalAuth, async (req, res) => {
  const { id } = req.params;
  const inputs = req.body?.vars || {};
  const store = readStore();
  const wf = store.workflows.find(w => w.id === id);
  if (!wf) return res.status(404).json({ error: 'Not found' });

  const conversationId = `wf_${uuid()}`;
  const run = {
    id: uuid(),
    workflowId: wf.id,
    conversationId: conversationId,
    name: wf.name || 'Workflow',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    logs: [],
    artifacts: [],
    outputByStep: {}
  };
  addRun(run);

  function runLog(level, msg, meta) { 
    run.logs.push({ ts: new Date().toISOString(), level, msg, meta }); 
  }

  logInfo('WF RUN start', { 
    corr: run.id, 
    conversationId: run.conversationId,
    workflowId: run.workflowId, 
    steps: (wf.steps || []).length, 
    allowExec: ALLOW_STEP_EXEC 
  });

  try {
    const vars = { ...(wf.defaults || {}), ...(inputs || {}) };

    for (const [stepIndex, step] of (wf.steps || []).entries()) {
      const stepKey = step.id || step.name || 'step';
      runLog('info', `Step start: ${step.name || step.id}`);

      const r = await runStep({ 
        chatConfig: wf.chat || {}, 
        step, 
        vars, 
        ctx: 'workflowRun', 
        corr: run.id,
        conversationId: run.conversationId,
        workflowId: run.workflowId,
        stepIndex
      });

      run.outputByStep[stepKey] = {
        ok: r.ok, 
        json: r.json, 
        validation: r.validation, 
        raw: r.raw, 
        logs: r.logs
      };
      run.logs.push(...r.logs.map(l => ({ ...l, step: step.name || step.id })));

      if (r.artifacts?.length) {
        for (const a of r.artifacts) {
          run.artifacts.push({ step: step.name || step.id, ...a });
        }
      }

      let execResults = [];
      let allStdout = '', allStderr = '';

      if (step.execute === true) {
        if (!ALLOW_STEP_EXEC) {
          runLog('warn', 'Execution blocked by server setting', { step: stepKey });
        } else if (r.ok && Array.isArray(r.json?.actions)) {
          const defaultTarget = step.target || step.runner || null;

          for (const [i, a] of r.json.actions.entries()) {
            if (!a || typeof a !== 'object') continue;
            const kind = String(a.type || a.kind || '').toLowerCase();
            const code = a.content || a.code || '';
            const cwd = sanitizeCwd(a.cwd || '');
            const timeoutMs = Math.min(Number(a.timeoutSec || 20000), 300000);
            const target = (a.meta && a.meta.target) ? String(a.meta.target) : defaultTarget;

            if (!['bash', 'python'].includes(kind)) {
              execResults.push({ index: i, kind, target: target || 'local', skipped: true, reason: 'unsupported kind' });
              continue;
            }

            try {
              if (target && getRunner(target)) {
                const r2 = await execRemote({ target, kind, code, cwd, env: a.env, timeoutMs });
                allStdout += r2.stdout || '';
                allStderr += r2.stderr || '';
                execResults.push({ 
                  index: i, 
                  kind, 
                  target, 
                  exitCode: r2.exitCode, 
                  killed: r2.killed, 
                  stdout: r2.stdout, 
                  stderr: r2.stderr 
                });
              } else {
                if (kind === 'bash') {
                  let out = '', err = '';
                  const rr = await execBash({ cmd: code, cwd, env: a.env, timeoutMs }, s => { out += s; allStdout += s; }, s => { err += s; allStderr += s; });
                  execResults.push({ 
                    index: i, 
                    kind, 
                    target: 'local', 
                    exitCode: rr.code, 
                    killed: rr.killed, 
                    stdout: out, 
                    stderr: err 
                  });
                } else {
                  let out = '', err = '';
                  const rr = await execPython({ script: code, cwd, env: a.env, timeoutMs }, s => { out += s; allStdout += s; }, s => { err += s; allStderr += s; });
                  execResults.push({ 
                    index: i, 
                    kind, 
                    target: 'local', 
                    exitCode: rr.code, 
                    killed: rr.killed, 
                    stdout: out, 
                    stderr: err 
                  });
                }
              }
            } catch (e) {
              execResults.push({ 
                index: i, 
                kind, 
                target: target || 'local', 
                error: String(e.message || e) 
              });
            }
          }

          run.outputByStep[stepKey] = { 
            ...(run.outputByStep[stepKey] || {}), 
            executed: true, 
            execResults 
          };

          if (step.exportExecStdoutAs) {
            const varName = String(step.exportExecStdoutAs).trim();
            if (varName) vars[varName] = allStdout;
          }
          if (step.exportExecStderrAs) {
            const varName = String(step.exportExecStderrAs).trim();
            if (varName) vars[varName] = allStderr;
          }
        }
      }

      const patterns = Array.isArray(step.failOnRegex) ? step.failOnRegex : (step.failOnRegex ? [step.failOnRegex] : []);
      const matched = [];
      for (const p of patterns) {
        try {
          const re = new RegExp(p, 'm');
          if (re.test(allStdout) || re.test(allStderr)) matched.push(p);
        } catch { }
      }
      const anyNonZero = Array.isArray(execResults) && execResults.some(r0 =>
        !r0.skipped && typeof r0.exitCode === 'number' && r0.exitCode !== 0
      );

      const failOnRegexHit = matched.length > 0;
      const failOnNonZero = !!step.failOnNonZeroExit && anyNonZero;

      if (failOnRegexHit || failOnNonZero) {
        runLog('warn', 'Step fail conditions met', { step: stepKey, failOnRegexHit, matched, failOnNonZero });
        if (step.stopOnFailure !== false) {
          run.status = 'failed';
          run.finishedAt = new Date().toISOString();
          return res.json(run);
        }
      }

      if (step.exportPath && r.json) {
        try {
          const value = lookup(r.json, step.exportPath);
          if (value !== undefined) vars[step.exportAs || step.exportPath] = value;
        } catch { }
      }

      if (!r.ok) {
        runLog('warn', `Step failed: ${step.name || step.id}`);
        if (step.stopOnFailure !== false) {
          run.status = 'failed';
          run.finishedAt = new Date().toISOString();
          logWarn('WF RUN failed', { 
            corr: run.id, 
            conversationId: run.conversationId,
            atStep: step.name || step.id 
          });
          return res.json(run);
        }
      } else {
        runLog('info', `Step ok: ${step.name || step.id}`);
      }
    }

    run.status = 'ok';
    run.finishedAt = new Date().toISOString();
    logInfo('WF RUN ok', { 
      corr: run.id, 
      conversationId: run.conversationId 
    });
    res.json(run);
  } catch (e) {
    run.status = 'error';
    run.finishedAt = new Date().toISOString();
    runLog('error', 'Run error', { message: e.message });
    logError('WF RUN error', { 
      corr: run.id, 
      conversationId: run.conversationId,
      message: e.message 
    });
    res.status(500).json(run);
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/workflows/:id/run`, (req, res) => {
  req.url = `/api/workflows/${req.params.id}/run`;
  app._router.handle(req, res);
});

// **NEW**: Replay workflow from gateway conversation
app.post('/api/workflows/:id/replay', requireInternalAuth, async (req, res) => {
  const { id } = req.params;
  const { conversation_id } = req.body || {};
  
  if (!conversation_id) {
    return res.status(400).json({ error: 'conversation_id required' });
  }
  
  try {
    // Fetch conversation from gateway
    const url = `${LLM_GATEWAY_API_BASE}/conversations/${encodeURIComponent(conversation_id)}/export`;
    const r = await axios.get(url);
    const convData = r.data;
    
    if (!convData?.conversation || !convData?.messages) {
      return res.status(404).json({ error: 'Conversation not found or empty' });
    }
    
    // Extract workflow metadata
    const conv = convData.conversation;
    const messages = convData.messages;
    
    res.json({
      ok: true,
      replay: true,
      workflow_id: id,
      conversation: {
        id: conv.id,
        created_at: conv.created_at,
        title: conv.title,
        model_id: conv.model_id
      },
      message_count: messages.length,
      messages: messages,
      note: 'Replay data fetched. Use this to debug or re-execute workflow steps.'
    });
  } catch (e) {
    logError('WF replay failed', { workflow_id: id, conversation_id, error: e.message });
    res.status(502).json({ 
      error: 'Failed to fetch conversation for replay', 
      detail: e.message 
    });
  }
});
if (BASE_PATH) app.post(`${BASE_PATH}/api/workflows/:id/replay`, (req, res) => {
  req.url = `/api/workflows/${req.params.id}/replay`;
  app._router.handle(req, res);
});

// **NEW**: Conversation export for workflow run
app.get('/api/runs/:id/conversation', async (req, res) => {
  const { id } = req.params;
  const run = runs.find(r => r.id === id);
  
  if (!run || !run.conversationId) {
    return res.status(404).json({ error: 'Run not found or no conversation ID' });
  }
  
  try {
    const url = `${LLM_GATEWAY_API_BASE}/conversations/${encodeURIComponent(run.conversationId)}/export`;
    const r = await axios.get(url);
    res.json(r.data);
  } catch (e) {
    logError('WF conversation export failed', { run_id: id, conversation_id: run.conversationId, error: e.message });
    res.status(502).json({ 
      error: 'Failed to fetch conversation', 
      detail: e.message 
    });
  }
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/runs/:id/conversation`, (req, res) => {
  req.url = `/api/runs/${req.params.id}/conversation`;
  app._router.handle(req, res);
});

app.get('/api/runs', (_req, res) => {
  res.json({ runs });
});
if (BASE_PATH) app.get(`${BASE_PATH}/api/runs`, (_req, res) => {
  res.json({ runs });
});

// Error handler
app.use((err, _req, res, _next) => {
  try { 
    logError('unhandled_error', { 
      message: err?.message || String(err), 
      stack: err?.stack 
    }); 
  } catch {}
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;