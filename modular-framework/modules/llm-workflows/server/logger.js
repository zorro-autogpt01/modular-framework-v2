const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_MAX = Number(process.env.LOG_MAX || 1000);
const logs = [];

function add(level, msg, meta) {
  const entry = { ts: new Date().toISOString(), level, msg, ...(meta||{}) };
  logs.push(entry); if (logs.length > LOG_MAX) logs.shift();
  const line = `[${entry.ts}] [${level.toUpperCase()}] ${msg} ${meta?JSON.stringify(meta):''}`;
  if (level === 'debug' && LOG_LEVEL === 'debug') console.debug(line);
  else if (level === 'info' && ['debug','info'].includes(LOG_LEVEL)) console.info(line);
  else if (level === 'warn' && LOG_LEVEL !== 'error') console.warn(line);
  else if (level === 'error') console.error(line);
}
const logDebug = (m,meta)=>add('debug',m,meta);
const logInfo = (m,meta)=>add('info',m,meta);
const logWarn = (m,meta)=>add('warn',m,meta);
const logError = (m,meta)=>add('error',m,meta);
module.exports = { logs, logDebug, logInfo, logWarn, logError };

