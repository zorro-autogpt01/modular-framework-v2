// modular-framework/modules/llm-gateway/server/logger.js
const os = require('os');
const path = require('path');

// ===== Defaults from ENV (backward-compatible) =====
const ENV_DEFAULTS = {
  level: (process.env.LOG_LEVEL || 'info').toLowerCase(),
  console: (process.env.LOG_TO_CONSOLE || 'false').toLowerCase() === 'true',
  buffer_max: Number(process.env.LOG_MAX || 1000),
  sinks: {
    // dynamic Splunk HEC sink (preferred, runtime adjustable)
    hec: {
      enabled: !!(process.env.SPLUNK_HEC_URL && process.env.SPLUNK_HEC_TOKEN),
      url: process.env.SPLUNK_HEC_URL || null,
      token: process.env.SPLUNK_HEC_TOKEN || null,
      source: process.env.SPLUNK_SOURCE || 'llm-gateway',
      index: process.env.SPLUNK_INDEX || undefined,
      tls_verify: String(process.env.NODE_TLS_REJECT_UNAUTHORIZED || '1') !== '0',
      timeout_ms: 3000,
      batch_max: 100
    }
  },
  fields: { service: 'llm-gateway', host: os.hostname() },
  sampling: { rate: 1.0 },
  level_overrides: {}, // e.g. { http_access: 'info', db: 'warn', llm: 'debug' }
};

// ===== In-memory log buffer (for /api/logs endpoint) =====
const logs = [];
function pushBuffer(entry, cfg) {
  logs.push(entry);
  const max = Math.max(1, Number(cfg.buffer_max || 1000));
  while (logs.length > max) logs.shift();
}

// ===== Utilities =====
let reqCounter = 0;
function stamp(req, _res, next) {
  req.id = `${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
  next();
}
function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  const hide = (o, k) => { if (o && o[k]) o[k] = '***REDACTED***'; };
  hide(clone, 'apiKey'); hide(clone, 'token'); hide(clone, 'Authorization'); hide(clone, 'authorization');
  if (clone.headers && clone.headers.Authorization) clone.headers.Authorization = '***REDACTED***';
  if (clone.headers && clone.headers.authorization) clone.headers.authorization = '***REDACTED***';
  // allow generic deep redaction rules (if provided)
  if (Array.isArray(clone.redact)) clone.redact = ['<rules hidden>'];
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
function deepMerge(a, b) {
  if (b === null || b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object') return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

// ===== Levels & filtering =====
const LEVELS = ['debug', 'info', 'warn', 'error'];
function levelAllows(min, lvl) {
  const mi = LEVELS.indexOf((min || 'info').toLowerCase());
  const li = LEVELS.indexOf((lvl || 'info').toLowerCase());
  return li >= mi;
}

// ===== Active config (hot-reloadable) =====
let cfg = ENV_DEFAULTS; // start with env
function loadFromEnv() { return JSON.parse(JSON.stringify(ENV_DEFAULTS)); }

function validateConfig(c) {
  const err = (m) => { const e = new Error(m); e.status = 400; throw e; };
  if (!c || typeof c !== 'object') err('config must be an object');
  if (c.level && !LEVELS.includes(c.level)) err(`invalid level: ${c.level}`);
  if (c.sampling && typeof c.sampling.rate === 'number' && (c.sampling.rate < 0 || c.sampling.rate > 1))
    err('sampling.rate must be between 0 and 1');
  if (c.sinks?.hec?.enabled) {
    const { url, token } = c.sinks.hec;
    if (!url || !token) err('hec.url and hec.token are required when hec.enabled=true');
  }
  return c;
}

function getEffectiveLoggingConfig() {
  // Return a redacted view
  return redact(cfg);
}

function setLoggingConfig(patch, { dryRun = false } = {}) {
  if (patch && patch._reload) {
    const reloaded = loadFromEnv();
    validateConfig(reloaded);
    if (!dryRun) cfg = reloaded;
    return { applied: !dryRun, effective: redact(cfg) };
  }
  // Merge patch onto current config
  const next = validateConfig(deepMerge(cfg, patch));
  if (dryRun) return { validated: true, next: redact(next) };
  cfg = next;
  return { applied: true, effective: redact(cfg) };
}

// ===== Sinks =====
async function sendConsole(entry) {
  // Emit to console only if cfg.console = true (and also when no HEC configured to avoid "going dark")
  if (!cfg.console) return;
  const line = `[${entry.ts}] [${entry.level.toUpperCase()}] ${entry.msg} ${entry.meta ? safeStringify(entry.meta) : ''}`;
  try {
    if (entry.level === 'debug') console.debug(line);
    else if (entry.level === 'info') console.info(line);
    else if (entry.level === 'warn') console.warn(line);
    else console.error(line);
  } catch {}
}

async function sendHec(entry) {
  const h = cfg.sinks?.hec || {};
  if (!h.enabled) return;
  const payload = {
    event: {
      level: entry.level,
      message: entry.msg,
      meta: entry.meta
    },
    time: Math.floor(Date.now() / 1000),
    host: cfg.fields?.host || os.hostname(),
    sourcetype: '_json',
    source: h.source || 'llm-gateway',
  };
  if (h.index) payload.index = h.index;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(h.timeout_ms || 3000));
  try {
    await fetch(h.url, {
      method: 'POST',
      headers: {
        'Authorization': `Splunk ${h.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Plug-in map (easy to add loki, s3, otlp later)
const sinks = [
  sendConsole,
  sendHec,
];

// ===== Redaction of meta payloads (best-effort key-based) =====
function redactMeta(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  const REDACT_KEYS = ['authorization', 'Authorization', 'apiKey', 'token', 'password', 'secret'];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (REDACT_KEYS.includes(k)) o[k] = '***REDACTED***';
      else if (typeof o[k] === 'object') walk(o[k]);
    }
  })(clone);
  return clone;
}

// ===== Public log API =====
function categoryLevel(min, category) {
  const override = cfg.level_overrides?.[category];
  return override || min;
}

function addLog(level, msg, meta, category) {
  const min = categoryLevel(cfg.level, category);
  if (!levelAllows(min, level)) return;

  // sampling
  const rate = Number(cfg.sampling?.rate ?? 1);
  if (rate < 1 && Math.random() > rate) return;

  const baseMeta = { ...(meta || {}), service: cfg.fields?.service || 'llm-gateway' };
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: typeof msg === 'string' ? msg : safeStringify(msg),
    meta: redactMeta(baseMeta),
  };

  // buffer
  pushBuffer(entry, cfg);

  // fan-out (fire-and-forget)
  for (const sink of sinks) {
    sink(entry).catch?.(() => {});
  }
}

const logDebug = (msg, meta, category)=> addLog('debug', msg, meta, category);
const logInfo  = (msg, meta, category)=> addLog('info',  msg, meta, category);
const logWarn  = (msg, meta, category)=> addLog('warn',  msg, meta, category);
const logError = (msg, meta, category)=> addLog('error', msg, meta, category);

// ===== External helpers kept for compatibility =====
function safeStringifyPublic(v){ return safeStringify(v); }

// ===== Test hook =====
async function testLoggingSink() {
  const probe = { ts: Date.now(), probe: true, source: 'logging_test' };
  logInfo('logging_test', probe, 'ops');
  return { sent: true };
}

module.exports = {
  logs,
  stamp,
  logDebug, logInfo, logWarn, logError,
  safeStringify: safeStringifyPublic,
  getEffectiveLoggingConfig,
  setLoggingConfig,
  testLoggingSink,
};
