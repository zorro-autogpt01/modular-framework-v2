const axios = require('axios');
const { logDebug, logWarn } = require('../logger');

function handleResponsesChunk(chunk, onDelta, onDone, onError) {
  const text = chunk.toString();
  logDebug('GW RESPONSES stream chunk', { size: Buffer.byteLength(text), head: text.slice(0, 800) });
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    try {
      if (payload === '[DONE]') { onDone?.(); continue; }
      const evt = JSON.parse(payload);
      logDebug('GW RESPONSES stream line parsed', { evtType: evt.type || evt.event || '', evtPreview: JSON.stringify(evt).slice(0, 400) });
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
    } catch (e) {
      logWarn('GW RESPONSES stream line parse error', { message: e.message, payload: payload.slice(0, 400) });
    }
  }
}

function handleChatCompletionsChunk(chunk, onDelta, onDone) {
  const str = chunk.toString();
  logDebug('GW CHAT stream chunk', { size: Buffer.byteLength(str), head: str.slice(0, 800) });
  for (const line of str.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    if (payload === '[DONE]') { onDone?.(); continue; }
    try {
      const json = JSON.parse(payload);
      logDebug('GW CHAT stream line parsed', { preview: JSON.stringify(json).slice(0, 400) });
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) onDelta?.(delta);
    } catch (e) {
      logWarn('GW CHAT stream line parse error', { message: e.message, payload: payload.slice(0, 400) });
    }
  }
}

function redactHeaders(h = {}) {
  const out = { ...(h || {}) };
  if (out.Authorization) out.Authorization = 'Bearer ***REDACTED***';
  return out;
}

async function callOpenAICompat({
  baseUrl, apiKey, model, messages, temperature,
  max_tokens, useResponses, reasoning, stream, onDelta, onDone, onError, rid
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

    logDebug('GW RESPONSES request', { rid, url, model, stream, headers: redactHeaders(headers) });
    logDebug('GW RESPONSES request body', { rid, body });

    if (stream) {
      const response = await axios.post(url, body, { headers, responseType: 'stream' });
      logDebug('GW RESPONSES streaming started', { rid, status: response.status });
      return new Promise((resolve) => {
        response.data.on('data', (chunk) => handleResponsesChunk(chunk, onDelta, onDone, onError));
        response.data.on('end', () => { logDebug('GW RESPONSES stream end', { rid }); onDone?.(); resolve(); });
        response.data.on('error', (e) => { logWarn('GW RESPONSES stream error', { rid, message: e.message }); onError?.(e.message); resolve(); });
      });
    } else {
      const resp = await axios.post(url, body, { headers });
      logDebug('GW RESPONSES non-stream response', { rid,
        status: resp.status,
        dataHead: JSON.stringify(resp.data)?.slice(0, 1000)
      });
      const data = resp.data;
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

  logDebug('GW CHAT request', { rid, url, model, stream, headers: redactHeaders(headers) });
  logDebug('GW CHAT request body', { rid, body });

  if (stream) {
    const response = await axios.post(url, body, { headers, responseType: 'stream' });
    logDebug('GW CHAT streaming started', { rid, status: response.status });
    return new Promise((resolve) => {
      response.data.on('data', (chunk) => handleChatCompletionsChunk(chunk, onDelta, onDone));
      response.data.on('end', () => { logDebug('GW CHAT stream end', { rid }); onDone?.(); resolve(); });
      response.data.on('error', (e) => { logWarn('GW CHAT stream error', { rid, message: e.message }); onError?.(e.message); resolve(); });
    });
  } else {
    const resp = await axios.post(url, body, { headers });
    logDebug('GW CHAT non-stream response', { rid,
      status: resp.status,
      dataHead: JSON.stringify(resp.data)?.slice(0, 1000)
    });
    const data = resp.data;
    const content = data?.choices?.[0]?.message?.content || '';
    return { content, raw: data };
  }
}

module.exports = { callOpenAICompat };
