const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_MAX = Number(process.env.LOG_MAX || 1000);

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
const logDebug = (msg, meta)=> addLog('debug', msg, meta);
const logInfo  = (msg, meta)=> addLog('info', msg, meta);
const logWarn  = (msg, meta)=> addLog('warn', msg, meta);
const logError = (msg, meta)=> addLog('error', msg, meta);

function stamp(req, _res, next) {
  req.id = `${Date.now().toString(36)}-${(++reqCounter).toString(36)}`;
  next();
}

module.exports = { logs, redact, safeStringify, addLog, logDebug, logInfo, logWarn, logError, stamp };
