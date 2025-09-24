const path = require('path');
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_MAX = Number(process.env.LOG_MAX || 1000);
const LOG_TO_CONSOLE = (process.env.LOG_TO_CONSOLE || 'false').toLowerCase() === 'true';
const IS_SPLUNK_CONFIGURED = Boolean(process.env.SPLUNK_HEC_URL && process.env.SPLUNK_HEC_TOKEN);

// Resolve splunk-logger helper from multiple candidate locations
let SPLUNK_LOGGER = null;
(function resolveSplunkLogger(){
  const candidates = [
    '/splunk-logger',
    path.join(__dirname, '..', 'splunk-logger'),
    path.join(__dirname, '..', '..', 'splunk-logger'),
    path.join(__dirname, '..', '..', '..', 'splunk-logger')
  ];
  for (const modPath of candidates) {
    try {
      SPLUNK_LOGGER = require(modPath);
      break;
    } catch (e) { /* continue */ }
  }
})();

const logs = [];
let reqCounter = 0;

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clone = JSON.parse(JSON.stringify(obj));
  if (clone.apiKey) clone.apiKey = '***REDACTED***';
  if (clone.headers && clone.headers.Authorization) clone.headers.Authorization = '***REDACTED***';
  if (clone.headers && clone.headers.authorization) clone.headers.authorization = '***REDACTED***';
  if (clone.Authorization) clone.Authorization = '***REDACTED***';
  if (clone.authorization) clone.authorization = '***REDACTED***';
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

function shouldConsole(level){
  if (LOG_TO_CONSOLE) return true;
  // If Splunk isn't configured, still emit to console so we don't go dark
  return !IS_SPLUNK_CONFIGURED;
}
function consoleOut(level, line){
  try {
    if (!shouldConsole(level)) return;
    if (level === 'debug' && LOG_LEVEL === 'debug') console.debug(line);
    else if (level === 'info' && (LOG_LEVEL === 'debug' || LOG_LEVEL === 'info')) console.info(line);
    else if (level === 'warn' && (LOG_LEVEL !== 'error')) console.warn(line);
    else if (level === 'error') console.error(line);
  } catch {}
}

function addLog(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...meta };
  logs.push(entry);
  if (logs.length > LOG_MAX) logs.shift();
  const line = `[${entry.ts}] [${level.toUpperCase()}] ${msg} ${meta ? safeStringify(meta) : ''}`;
  consoleOut(level, line);
}

function augmentMeta(meta){
  const base = (meta && typeof meta === 'object') ? meta : {};
  return { service: 'llm-gateway', ...base };
}

const logDebug = (msg, meta)=> { const m = augmentMeta(meta); addLog('debug', msg, m); try { SPLUNK_LOGGER?.logDebug?.(msg, m); } catch {} };
const logInfo  = (msg, meta)=> { const m = augmentMeta(meta); addLog('info', msg, m);  try { SPLUNK_LOGGER?.logInfo?.(msg, m); }  catch {} };
const logWarn  = (msg, meta)=> { const m = augmentMeta(meta); addLog('warn', msg, m);  try { SPLUNK_LOGGER?.logWarn?.(msg, m); }  catch {} };
const logError = (msg, meta)=> { const m = augmentMeta(meta); addLog('error', msg, m); try { SPLUNK_LOGGER?.logError?.(msg, m); } catch {} };

function stamp(req, _res, next) {
  req.id = `${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
  next();
}

module.exports = { logs, redact, safeStringify, addLog, logDebug, logInfo, logWarn, logError, stamp };