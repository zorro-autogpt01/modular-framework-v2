const axios = require('axios');
const { logDebug } = require('../logger');

async function callOllama({ baseUrl, model, messages, temperature, stream, onDelta, onDone, onError }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = { model, messages, stream };
  if (typeof temperature === 'number') body.options = { ...(body.options || {}), temperature };

  logDebug('GW OLLAMA request', { url, model, stream });

  if (stream) {
    const response = await axios.post(url, body, { responseType: 'stream' });
    return new Promise((resolve) => {
      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const evt = JSON.parse(line);
            if (evt.message && evt.message.content) onDelta?.(evt.message.content);
            if (evt.done) onDone?.();
          } catch {}
        }
      });
      response.data.on('end', () => { onDone?.(); resolve(); });
      response.data.on('error', (e) => { onError?.(e.message); resolve(); });
    });
  } else {
    const { data } = await axios.post(url, body);
    return { content: data?.message?.content || '', raw: data };
  }
}

module.exports = { callOllama };

