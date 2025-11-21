// modules/llm-chat/server.js
// LLM Chat backend: OpenAI / OpenAI-compatible / Ollama with streaming (SSE)
// GPT-5 friendly: auto-routes GPT-5 models to /v1/responses and supports
// max_completion_tokens (chat.completions) vs max_output_tokens (responses).
// Enhanced logging with redaction + in-memory ring buffer and /api/logs endpoints.

const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3004;
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase(); // debug|info|warn|error
const LOG_MAX = Number(process.env.LOG_MAX || 1000);               // max entries in ring buffer

// ---------- Simple ring-buffer logger with redaction ----------
const logs = [];
let reqCounter = 0;

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone.apiKey) clone.apiKey = '***REDACTED***';
  if (clone.headers && clone.headers.Authorization) clone.headers.Authorization = '***REDACTED***';
  if (clone.headers && clone.headers.authorization) clone.headers.authorization = '***REDACTED***';
  return clone;
}
function safeStringify(v) {
  try {
    const seen = new WeakSet();
    return JSON.stringify(v, (k, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
  } catch {
    return '[unstringifiable]';
  }
}
function addLog(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  logs.push(entry);
  if (logs.length > LOG_MAX) logs.shift();
  const line = `[${entry.ts}] [${level.toUpperCase()}] ${msg} ${meta ? safeStringify(meta) : ''}`;
  if (level === 'debug' && LOG_LEVEL === 'debug') console.debug(line);
  else if (level === 'info' && (LOG_LEVEL === 'debug' || LOG_LEVEL === 'info')) console.info(line);
  else if (level === 'warn' && (LOG_LEVEL !== 'error')) console.warn(line);
  else if (level === 'error') console.error(line);
}
function logDebug(msg, meta) { addLog('debug', msg, meta); }
function logInfo(msg, meta)  { addLog('info', msg, meta); }
function logWarn(msg, meta)  { addLog('warn', msg, meta); }
function logError(msg, meta) { addLog('error', msg, meta); }

// ---------- Middleware ----------
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  req.id = `${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
  next();
});

// Static files (frontend)
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Health & Info ----------
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/config', (_, res) => res.sendFile(path.join(__dirname, 'public', 'config.html')));
app.get('/health', (_, res) => res.json({ status: 'healthy' }));
app.get('/api/info', (_, res) => res.json({ module: 'llm-chat', version: '1.5.0', status: 'ready' }));

// ---------- Logs API ----------
app.get('/api/logs', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 2000));
  const start = Math.max(0, logs.length - limit);
  res.json(logs.slice(start));
});
app.post('/api/logs/clear', (_req, res) => {
  logs.length = 0;
  res.json({ ok: true });
});

// ---------- Helpers: upstream error handling & retries ----------
function isReadable(x) { return x && typeof x.pipe === 'function'; }
async function readUpstreamBody(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (isReadable(data)) {
    return await new Promise((resolve) => {
      let buf = '';
      try {
        data.setEncoding('utf8');
        data.on('data', (c) => buf += c);
        data.on('end', () => resolve(buf));
        data.on('error', () => resolve('[error reading upstream stream]'));
      } catch {
        resolve('[unreadable upstream stream]');
      }
    });
  }
  try { return safeStringify(data); } catch { return '[unstringifiable upstream data]'; }
}
async function extractErrAsync(err) {
  const status = err?.response?.status;
  const body = await readUpstreamBody(err?.response?.data);
  const baseMsg = err?.message || 'Unknown error';
  const trimmed = body ? body.slice(0, 4000) : '';
  return status ? `Upstream ${status}: ${trimmed || baseMsg}` : baseMsg;
}
async function isUnsupportedParamErrorAsync(err, paramName) {
  const body = await readUpstreamBody(err?.response?.data);
  const raw = body || err?.message || '';
  const msg = raw.toLowerCase();
  return msg.includes('unsupported') && msg.includes(`'${paramName.toLowerCase()}'`);
}

// ---------- Chat Endpoint ----------
/**
 * POST /api/chat
 * Body:
 * {
 *   provider: 'openai' | 'openai-compatible' | 'ollama',
 *   baseUrl: string,
 *   apiKey?: string,
 *   model: string,
 *   messages: [{role, content}],
 *   temperature?: number,   // omit or set; GPT-5 will be sent without by default
 *   max_tokens?: number,
 *   stream?: boolean,
 *   useResponses?: boolean, // optional: force OpenAI /v1/responses
 *   reasoning?: boolean     // hint to treat as reasoning model (chat.completions)
 * }
 */
app.post('/api/chat', async (req, res) => {
  const rid = req.id;
  const {
    provider = 'openai',
    baseUrl,
    apiKey,
    model,
    messages = [],
    temperature,  // undefined means "omit"
    max_tokens,
    stream = true,
    useResponses = false,
    reasoning = false
  } = req.body || {};

  const problems = [];
  if (!baseUrl) problems.push('baseUrl is required');
  if (!model) problems.push('model is required');
  if (!Array.isArray(messages)) problems.push('messages must be an array');
  if ((provider === 'openai' || provider === 'openai-compatible') && !apiKey) {
    problems.push('apiKey is required for OpenAI/OpenAI-compatible providers');
  }
  if (problems.length) {
    logWarn('Validation failed', { rid, problems, body: redact(req.body) });
    return res.status(400).json({ error: 'Validation failed', details: problems });
  }

  const sseMode = !!stream;
  if (sseMode) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  }
  const sendSSE = (payload) => {
    if (!sseMode) return;
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { try { res.end(); } catch {} }
  };

  // Auto-route GPT-5 models to Responses API on OpenAI
  const isGpt5 = /^gpt-5/i.test(model) || /^o5/i.test(model);
  const autoResponses = isGpt5 && provider === 'openai';

  logInfo('LLM request', {
    rid, provider, baseUrl, model,
    stream: !!stream,
    useResponses: useResponses || autoResponses,
    reasoning: !!reasoning,
    temperature: (typeof temperature === 'number' ? temperature : null),
    max_tokens: max_tokens ?? null,
  });
  logDebug('LLM messages', { rid, messagesCount: messages.length });

  try {
    if (provider === 'ollama') {
      return await handleOllama({ res, sendSSE, rid, baseUrl, model, messages, temperature, sseMode });
    }
    return await handleOpenAICompat({
      res, sendSSE, rid,
      baseUrl, apiKey, model, messages, temperature,
      max_tokens, useResponses: useResponses || autoResponses, reasoning, sseMode
    });
  } catch (err) {
    const message = await extractErrAsync(err);
    logError('LLM fatal error', { rid, message });
    if (sseMode) {
      sendSSE({ type: 'error', message });
      try { res.end(); } catch {}
    } else {
      res.status(500).json({ error: message });
    }
  }
});

// ---------- Handlers ----------
async function handleOllama({ res, sendSSE, rid, baseUrl, model, messages, temperature, sseMode }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = { model, messages, stream: sseMode };
  if (typeof temperature === 'number') body.options = { ...(body.options || {}), temperature };

  logDebug('OLLAMA request', { rid, url, body: redact(body) });

  if (sseMode) {
    const response = await axios.post(url, body, { responseType: 'stream' });
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt.message && evt.message.content) sendSSE({ type: 'delta', content: evt.message.content });
          if (evt.done) sendSSE({ type: 'done' });
        } catch { /* ignore parse errors */ }
      }
    });
    response.data.on('end', () => { logDebug('OLLAMA stream end', { rid }); res.end(); });
    response.data.on('error', (e) => { logWarn('OLLAMA stream error', { rid, err: e.message }); sendSSE({ type:'error', message: e.message }); res.end(); });
  } else {
    const { data } = await axios.post(url, body);
    const content = data?.message?.content || '';
    res.json({ content });
  }
}

async function handleOpenAICompat({
  res, sendSSE, rid,
  baseUrl, apiKey, model, messages, temperature,
  max_tokens, useResponses, reasoning, sseMode
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const base = baseUrl.replace(/\/$/, '');
  const isGpt5 = /^gpt-5/i.test(model) || /^o5/i.test(model);

  // ---- OpenAI Responses API ----
  if (useResponses) {
    const url = `${base}/v1/responses`;
    const rBodyBase = { model, input: messages, stream: sseMode };

    // IMPORTANT: omit temperature for GPT-5 models by default to avoid 400s
    if (!isGpt5 && typeof temperature === 'number' && !Number.isNaN(temperature)) {
      rBodyBase.temperature = temperature;
    }
    if (max_tokens) rBodyBase.max_output_tokens = max_tokens;

    logDebug('RESPONSES request', { rid, url, body: redact(rBodyBase) });

    async function postResponses(body) {
      return axios.post(url, body, { headers, responseType: sseMode ? 'stream' : 'json' });
    }

    try {
      if (sseMode) {
        const response = await postResponses(rBodyBase);
        response.data.on('data', (chunk) => handleResponsesChunk(chunk, sendSSE));
        response.data.on('end', () => { logDebug('RESPONSES stream end', { rid }); res.end(); });
        response.data.on('error', (e) => { logWarn('RESPONSES stream error', { rid, err: e.message }); sendSSE({ type:'error', message: e.message }); res.end(); });
      } else {
        const { data } = await postResponses(rBodyBase);
        const content = data?.output_text?.join?.('') || data?.message?.content || data?.content || '';
        res.json({ content });
      }
    } catch (err) {
      // Auto-retry for unsupported parameters (e.g., temperature)
      if (await isUnsupportedParamErrorAsync(err, 'temperature') && rBodyBase.temperature !== undefined) {
        logWarn('RESPONSES retry without temperature', { rid });
        const rBodyRetry = { ...rBodyBase };
        delete rBodyRetry.temperature;

        if (sseMode) {
          try {
            const response = await axios.post(url, rBodyRetry, { headers, responseType: 'stream' });
            response.data.on('data', (chunk) => handleResponsesChunk(chunk, sendSSE));
            response.data.on('end', () => { logDebug('RESPONSES stream end (retry)', { rid }); res.end(); });
            response.data.on('error', (e) => { logWarn('RESPONSES stream error (retry)', { rid, err: e.message }); sendSSE({ type:'error', message: e.message }); res.end(); });
            return;
          } catch (e2) { throw e2; }
        } else {
          try {
            const { data } = await axios.post(url, rBodyRetry, { headers });
            const content = data?.output_text?.join?.('') || data?.message?.content || data?.content || '';
            res.json({ content });
            return;
          } catch (e2) { throw e2; }
        }
      }
      throw err; // bubble up other errors
    }
    return;
  }

  // ---- Chat Completions API (OpenAI or compatible) ----
  const url = `${base}/v1/chat/completions`;
  const body = { model, messages, stream: sseMode };

  // Include temperature only if explicitly provided
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) {
    body.temperature = temperature;
  }

  if (max_tokens) {
    if (isGpt5 || reasoning === true) body.max_completion_tokens = max_tokens;
    else body.max_tokens = max_tokens;
  }

  logDebug('CHAT.COMPLETIONS request', { rid, url, body: redact(body) });

  if (sseMode) {
    const response = await axios.post(url, body, { headers, responseType: 'stream' });
    response.data.on('data', (chunk) => handleChatCompletionsChunk(chunk, sendSSE));
    response.data.on('end', () => { logDebug('CHAT stream end', { rid }); res.end(); });
    response.data.on('error', (e) => { logWarn('CHAT stream error', { rid, err: e.message }); sendSSE({ type:'error', message: e.message }); res.end(); });
  } else {
    const { data } = await axios.post(url, body, { headers });
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ content });
  }
}

// ---------- Stream chunk parsers ----------
function handleResponsesChunk(chunk, sendSSE) {
  const text = chunk.toString();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;

    // New-style Responses events use typed objects; completion isn't "[DONE]"
    try {
      if (payload === '[DONE]') { // legacy guard
        sendSSE({ type: 'done' });
        continue;
      }

      const evt = JSON.parse(payload);

      // Common event kinds observed on /v1/responses streams:
      // - response.output_text.delta  -> { delta: "..." }
      // - response.output_text        -> final text chunk(s)
      // - response.completed          -> end of stream
      // - error                       -> error details
      // - ping                        -> keepalive (ignore)

      const t = evt.type || evt.event || '';

      if (t === 'response.output_text.delta') {
        const delta = evt.delta ?? evt.text ?? evt.output_text?.[0]?.content ?? '';
        if (delta) sendSSE({ type: 'delta', content: String(delta) });
        continue;
      }

      if (t === 'response.output_text') {
        // some providers send consolidated text at the end
        const textOut = evt.output_text?.join?.('') || evt.text || '';
        if (textOut) sendSSE({ type: 'delta', content: String(textOut) });
        continue;
      }

      if (t === 'response.completed') {
        sendSSE({ type: 'done' });
        continue;
      }

      if (t === 'error' || evt.error) {
        const message =
          evt.error?.message || evt.message || 'Unknown error from Responses stream';
        sendSSE({ type: 'error', message });
        continue;
      }

      // Fallbacks (older shapes)
      const deltaText =
        evt?.output_text?.[0]?.content ||
        evt?.delta?.text ||
        evt?.message?.content ||
        evt?.content;
      if (deltaText) {
        sendSSE({ type: 'delta', content: deltaText });
      }
    } catch {
      // ignore malformed/keepalive lines
    }
  }
}

function handleChatCompletionsChunk(chunk, sendSSE) {
  const str = chunk.toString();
  for (const line of str.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    if (payload === '[DONE]') { sendSSE({ type: 'done' }); continue; }
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) sendSSE({ type: 'delta', content: delta });
    } catch { /* ignore */ }
  }
}

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`LLM Chat Module listening on :${PORT} (LOG_LEVEL=${LOG_LEVEL})`);
});
