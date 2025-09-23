const axios = require('axios');
const { logDebug, logWarn } = require('./logger');

// Streams via SSE and forwards deltas to callbacks. Uses llm-gateway workflows compat endpoint by default.
async function chatStream({ llmGatewayUrl, overrides, messages, onDelta, onError, onDone }) {
  const url = (llmGatewayUrl || process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010/api/compat/llm-workflows').replace(/\/$/, '');
  const {
    provider='openai', baseUrl, apiKey, model,
    temperature, max_tokens, system
  } = overrides || {};

  const payload = {
    provider, baseUrl, apiKey, model,
    messages: system ? [{ role:'system', content: system }, ...messages] : messages,
    temperature, max_tokens, stream: true
  };

  const red = { ...payload, apiKey: payload.apiKey ? '***REDACTED***' : undefined };
  logDebug('WF -> GW stream POST', { url, payload: red });

  const resp = await axios.post(url, payload, { responseType: 'stream' });
  logDebug('WF <- GW stream started', { status: resp.status });

  resp.data.on('data', (chunk) => {
    const str = chunk.toString();
    logDebug('WF <- GW SSE chunk', { size: Buffer.byteLength(str), head: str.slice(0, 800) });
    for (const line of str.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = line.replace(/^data:\s*/, '').trim();
      if (!payload) continue;
      if (payload === '[DONE]') { onDone?.(); continue; }
      try {
        const evt = JSON.parse(payload);
        logDebug('WF <- GW SSE parsed', { evt });
        if ((evt.type === 'llm.delta' && typeof evt.data === 'string')) {
          onDelta?.(evt.data);
        } else if (evt.type === 'delta' && typeof evt.content === 'string') {
          onDelta?.(evt.content);
        } else if (evt.type === 'error') {
          onError?.(evt.message || 'LLM error');
        } else if (evt.type === 'done') {
          onDone?.();
        } else {
          const content =
            evt?.choices?.[0]?.delta?.content ??
            evt?.output_text?.[0]?.content ??
            evt?.message?.content ??
            evt?.content;
          if (content) onDelta?.(String(content));
        }
      } catch (e) {
        // ignore malformed keepalives
      }
    }
  });
  resp.data.on('end', () => { logDebug('WF <- GW stream end'); onDone?.(); });
  resp.data.on('error', (e) => { logWarn('WF <- GW stream error', { msg:e.message }); onError?.(e.message); });
}

module.exports = { chatStream };
