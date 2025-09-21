const axios = require('axios');
const { logDebug, logWarn } = require('../logger');

function handleResponsesChunk(chunk, onDelta, onDone, onError) {
  const text = chunk.toString();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    try {
      if (payload === '[DONE]') { onDone?.(); continue; }
      const evt = JSON.parse(payload);
      const t = evt.type || evt.event || '';
      if (t === 'response.output_text.delta') {
        const delta = evt.delta ?? evt.text ?? evt.output_text?.[0]?.content ?? '';
        if (delta) onDelta?.(String(delta));
        continue;
      }
      if (t === 'response.output_text') {
        const textOut = evt.output_text?.join?.('') || evt.text || '';
        if (textOut) onDelta?.(String(textOut));
        continue;
      }
      if (t === 'response.completed') { onDone?.(); continue; }
      if (t === 'error' || evt.error) {
        onError?.(evt.error?.message || evt.message || 'Unknown error from Responses stream');
        continue;
      }
      const deltaText =
        evt?.output_text?.[0]?.content ||
        evt?.delta?.text ||
        evt?.message?.content ||
        evt?.content;
      if (deltaText) onDelta?.(deltaText);
    } catch {}
  }
}

function handleChatCompletionsChunk(chunk, onDelta, onDone) {
  const str = chunk.toString();
  for (const line of str.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    if (payload === '[DONE]') { onDone?.(); continue; }
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) onDelta?.(delta);
    } catch {}
  }
}

async function callOpenAICompat({
  baseUrl, apiKey, model, messages, temperature,
  max_tokens, useResponses, reasoning, stream, onDelta, onDone, onError
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const base = baseUrl.replace(/\/$/, '');
  const isGpt5 = /^gpt-5/i.test(model) || /^o5/i.test(model);

  if (useResponses) {
    const url = `${base}/v1/responses`;
    const body = { model, input: messages, stream };
    if (!isGpt5 && typeof temperature === 'number' && !Number.isNaN(temperature)) body.temperature = temperature;
    if (!isGpt5 && max_tokens) body.max_output_tokens = max_tokens;

    logDebug('GW RESPONSES request', { url, model, stream });

    if (stream) {
      const response = await axios.post(url, body, { headers, responseType: 'stream' });
      return new Promise((resolve) => {
        response.data.on('data', (chunk) => handleResponsesChunk(chunk, onDelta, onDone, onError));
        response.data.on('end', () => { onDone?.(); resolve(); });
        response.data.on('error', (e) => { onError?.(e.message); resolve(); });
      });
    } else {
      const { data } = await axios.post(url, body, { headers });
      const content =
        data?.output_text?.join?.('') ||
        data?.message?.content ||
        data?.content || '';
      return { content, raw: data };
    }
  }

  // Chat completions
  const url = `${base}/v1/chat/completions`;
  const body = { model, messages, stream };
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) body.temperature = temperature;
  if (max_tokens) {
    if (isGpt5 || reasoning === true) body.max_completion_tokens = max_tokens;
    else body.max_tokens = max_tokens;
  }

  logDebug('GW CHAT request', { url, model, stream });

  if (stream) {
    const response = await axios.post(url, body, { headers, responseType: 'stream' });
    return new Promise((resolve) => {
      response.data.on('data', (chunk) => handleChatCompletionsChunk(chunk, onDelta, onDone));
      response.data.on('end', () => { onDone?.(); resolve(); });
      response.data.on('error', (e) => { onError?.(e.message); resolve(); });
    });
  } else {
    const { data } = await axios.post(url, body, { headers });
    const content = data?.choices?.[0]?.message?.content || '';
    return { content, raw: data };
  }
}

module.exports = { callOpenAICompat };

