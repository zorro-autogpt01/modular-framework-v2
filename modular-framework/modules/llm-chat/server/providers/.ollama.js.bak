const axios = require('axios');
const { logDebug, logWarn } = require('../logger');

async function handleOllama({ res, sendSSE, rid, baseUrl, model, messages, temperature, sseMode }) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = { model, messages, stream: sseMode };
  if (typeof temperature === 'number') body.options = { ...(body.options || {}), temperature };

  logDebug('OLLAMA request', { rid, url, body });

  if (sseMode) {
    const response = await axios.post(url, body, { responseType: 'stream' });
    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt.message && evt.message.content) sendSSE({ type: 'delta', content: evt.message.content });
          if (evt.done) sendSSE({ type: 'done' });
        } catch { /* ignore */ }
      }
    });
    response.data.on('end', () => { logDebug('OLLAMA stream end', { rid }); res.end(); });
    response.data.on('error', (e) => { logWarn('OLLAMA stream error', { rid, err: e.message }); sendSSE({ type:'error', message: e.message }); res.end(); });
  } else {
    const { data } = await axios.post(url, body);
    const content = data?.message?.content || '';
    res.json({ content });
  }
}

module.exports = { handleOllama };
