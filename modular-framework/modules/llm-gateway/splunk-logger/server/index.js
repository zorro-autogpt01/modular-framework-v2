const os = require('os');

const SPLUNK_HEC_URL = process.env.SPLUNK_HEC_URL;
const SPLUNK_HEC_TOKEN = process.env.SPLUNK_HEC_TOKEN;
const SPLUNK_SOURCE = process.env.SPLUNK_SOURCE || 'llm-gateway';
const SPLUNK_INDEX = process.env.SPLUNK_INDEX || undefined; // optional

const configured = !!(SPLUNK_HEC_URL && SPLUNK_HEC_TOKEN);

async function logEvent(level, msg, meta) {
  if (!configured) return;
  const payload = {
    event: {
      level,
      message: typeof msg === 'string' ? msg : JSON.stringify(msg),
      meta
    },
    time: Math.floor(Date.now() / 1000),
    host: os.hostname(),
    sourcetype: '_json',
    source: SPLUNK_SOURCE
  };
  if (SPLUNK_INDEX) payload.index = SPLUNK_INDEX;
  try {
    await fetch(SPLUNK_HEC_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Splunk ${SPLUNK_HEC_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (e) { /* ignore logging failures */ }
}

function logDebug(msg, meta){ return logEvent('debug', msg, meta); }
function logInfo(msg, meta){ return logEvent('info', msg, meta); }
function logWarn(msg, meta){ return logEvent('warn', msg, meta); }
function logError(msg, meta){ return logEvent('error', msg, meta); }

module.exports = { logDebug, logInfo, logWarn, logError };