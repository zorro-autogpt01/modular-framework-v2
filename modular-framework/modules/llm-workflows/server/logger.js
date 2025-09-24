const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_MAX = Number(process.env.LOG_MAX || 1000);
const LOG_TO_CONSOLE = String(process.env.LOG_TO_CONSOLE || 'true').toLowerCase() !== 'false';
const SOURCE = process.env.SPLUNK_SOURCE || 'llm-workflows';

let SPLUNK = null;
try {
  SPLUNK = require('../splunk-logger');
  console.log('Splunk logger loaded for llm-workflows');
} catch (e) {
  console.log('Splunk logger not available for llm-workflows:', e.message);
}

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

function add(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta || {}) };
  logs.push(entry);
  if (logs.length > LOG_MAX) logs.shift();

  const line = `[${entry.ts}] [${level.toUpperCase()}] ${msg} ${meta ? safeStringify(meta) : ''}`;
  if (LOG_TO_CONSOLE) {
    if (level === 'debug' && LOG_LEVEL === 'debug') console.debug(line);
    else if (level === 'info' && (LOG_LEVEL === 'info' || LOG_LEVEL === 'debug')) console.info(line);
    else if (level === 'warn' && LOG_LEVEL !== 'error') console.warn(line);
    else if (level === 'error') console.error(line);
  }

  try {
    if (SPLUNK) {
      const metaWithSource = { source: SOURCE, ...(meta || {}) };
      if (level === 'debug' && SPLUNK.logDebug) SPLUNK.logDebug(msg, metaWithSource);
      else if (level === 'info' && SPLUNK.logInfo) SPLUNK.logInfo(msg, metaWithSource);
      else if (level === 'warn' && SPLUNK.logWarn) SPLUNK.logWarn(msg, metaWithSource);
      else if (level === 'error' && SPLUNK.logError) SPLUNK.logError(msg, metaWithSource);
    }
  } catch { /* ignore Splunk failures */ }
}

const logDebug = (m, meta) => add('debug', m, meta);
const logInfo = (m, meta) => add('info', m, meta);
const logWarn = (m, meta) => add('warn', m, meta);
const logError = (m, meta) => add('error', m, meta);

module.exports = { logs, logDebug, logInfo, logWarn, logError };

