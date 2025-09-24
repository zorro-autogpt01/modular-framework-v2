const axios = require('axios');
const { logDebug, logInfo, logWarn, logError } = require('../logger');

async function callOllama({ baseUrl, model, messages, temperature, stream, onDelta, onDone, onError, rid }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = { model, messages, stream };
  if (typeof temperature === 'number') body.options = { ...(body.options || {}), temperature };

  logDebug('GW OLLAMA request', { rid, url, model, stream });
  logDebug('GW OLLAMA request body', { rid, body });

  if (stream) {
    const response = await axios.post(url, body, { responseType: 'stream' });
    logDebug('GW OLLAMA streaming started', { rid, status: response.status });

    return new Promise((resolve) => {
      response.data.on('data', (chunk) => {
        const str = chunk.toString();
        logDebug('GW OLLAMA stream chunk', { rid, size: Buffer.byteLength(str), raw: str.slice(0, 800) });
        const lines = str.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            logDebug('GW OLLAMA stream line parsed', { rid, evt });
            if (evt.message && evt.message.content) onDelta?.(evt.message.content);
            if (evt.done) onDone?.();
          } catch (e) {
            logWarn('GW OLLAMA stream line parse error', { rid, message: e.message, line: line.slice(0, 300) });
          }
        }
      });
      response.data.on('end', () => { logDebug('GW OLLAMA stream end', { rid }); onDone?.(); resolve(); });
      response.data.on('error', (e) => { logWarn('GW OLLAMA stream error', { rid, message: e.message }); onError?.(e.message); resolve(); });
    });
  } else {
    const resp = await axios.post(url, body);
    logDebug('GW OLLAMA non-stream response', { rid,
      status: resp.status,
      dataHead: JSON.stringify(resp.data)?.slice(0, 1000)
    });
    const { data } = resp;
    return { content: data?.message?.content || '', raw: data };
  }
}

module.exports = { callOllama };
