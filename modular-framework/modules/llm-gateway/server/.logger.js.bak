const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_MAX = Number(process.env.LOG_MAX || 1000);
const logs = [];

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
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  logs.push(entry); if (logs.length > LOG_MAX) logs.shift();
  const line = `[${entry.ts}] [${level.toUpperCase()}] ${msg} ${meta ? safeStringify(meta) : ''}`;
  if (level === 'debug' && LOG_LEVEL === 'debug') console.debug(line);
  else if (level === 'info' && (LOG_LEVEL === 'debug' || LOG_LEVEL === 'info')) console.info(line);
  else if (level === 'warn' && (LOG_LEVEL !== 'error')) console.warn(line);
  else if (level === 'error') console.error(line);
}
const logDebug = (m, meta) => addLog('debug', m, meta);
const logInfo  = (m, meta) => addLog('info', m, meta);
const logWarn  = (m, meta) => addLog('warn', m, meta);
const logError = (m, meta) => addLog('error', m, meta);

module.exports = { logDebug, logInfo, logWarn, logError };

