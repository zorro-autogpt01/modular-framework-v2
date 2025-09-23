const axios = require('axios');
const { logDebug, logInfo, logWarn, logError } = require('../logger');

async function callOllama({ baseUrl, model, messages, temperature, stream, onDelta, onDone, onError }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = { model, messages, stream };
  if (typeof temperature === 'number') body.options = { ...(body.options || {}), temperature };

  logDebug('GW OLLAMA request', { url, model, stream });
  logDebug('GW OLLAMA request body', { body });

  if (stream) {
    const response = await axios.post(url, body, { responseType: 'stream' });
    logDebug('GW OLLAMA streaming started', { status: response.status });

    return new Promise((resolve) => {
      response.data.on('data', (chunk) => {
        const str = chunk.toString();
        logDebug('GW OLLAMA stream chunk', { size: Buffer.byteLength(str), raw: str.slice(0, 800) });
        const lines = str.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            logDebug('GW OLLAMA stream line parsed', { evt });
            if (evt.message && evt.message.content) onDelta?.(evt.message.content);
            if (evt.done) onDone?.();
          } catch (e) {
            logWarn('GW OLLAMA stream line parse error', { message: e.message, line: line.slice(0, 300) });
          }
        }
      });
      response.data.on('end', () => { logDebug('GW OLLAMA stream end'); onDone?.(); resolve(); });
      response.data.on('error', (e) => { logWarn('GW OLLAMA stream error', { message: e.message }); onError?.(e.message); resolve(); });
    });
  } else {
    const resp = await axios.post(url, body);
    logDebug('GW OLLAMA non-stream response', {
      status: resp.status,
      dataHead: JSON.stringify(resp.data)?.slice(0, 1000)
    });
    const { data } = resp;
    return { content: data?.message?.content || '', raw: data };
  }
}

module.exports = { callOllama };
