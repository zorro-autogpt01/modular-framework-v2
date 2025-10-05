const axios = require('axios');
const { logDebug, logWarn } = require('../logger');
const { extractErrAsync, isUnsupportedParamErrorAsync } = require('../util/http');

function handleResponsesChunk(chunk, sendSSE) {
  const text = chunk.toString();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    try {
      if (payload === '[DONE]') { sendSSE({ type: 'done' }); continue; }
      const evt = JSON.parse(payload);
      const t = evt.type || evt.event || '';
      if (t === 'response.output_text.delta') {
        const delta = evt.delta ?? evt.text ?? evt.output_text?.[0]?.content ?? '';
        if (delta) sendSSE({ type:'delta', content:String(delta) });
        continue;
      }
      if (t === 'response.output_text') {
        const textOut = evt.output_text?.join?.('') || evt.text || '';
        if (textOut) sendSSE({ type:'delta', content:String(textOut) });
        continue;
      }
      if (t === 'response.completed') { sendSSE({ type:'done' }); continue; }
      if (t === 'error' || evt.error) {
        const message = evt.error?.message || evt.message || 'Unknown error from Responses stream';
        sendSSE({ type:'error', message }); continue;
      }
      const deltaText =
        evt?.output_text?.[0]?.content ||
        evt?.delta?.text ||
        evt?.message?.content ||
        evt?.content;
      if (deltaText) sendSSE({ type:'delta', content: deltaText });
    } catch { /* ignore */ }
  }
}

function handleChatCompletionsChunk(chunk, sendSSE) {
  const str = chunk.toString();
  for (const line of str.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.replace(/^data:\s*/, '').trim();
    if (!payload) continue;
    if (payload === '[DONE]') { sendSSE({ type: 'done' }); continue; }
    try {
      const json = JSON.parse(payload);
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) sendSSE({ type: 'delta', content: delta });
    } catch { /* ignore */ }
  }
}

async function handleOpenAICompat({
  res, sendSSE, rid,
  baseUrl, apiKey, model, messages, temperature,
  max_tokens, useResponses, reasoning, sseMode,
  conversationId
}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const base = baseUrl.replace(/\/$/, '');
  const isGpt5 = /^gpt-5/i.test(model) || /^o5/i.test(model);

  if (useResponses) {
    const url = `${base}/v1/responses`;
    const rBodyBase = { model, input: messages, stream: sseMode };
    if (!isGpt5 && typeof temperature === 'number' && !Number.isNaN(temperature)) {
      rBodyBase.temperature = temperature;
    }
    if (!isGpt5 && max_tokens) rBodyBase.max_output_tokens = max_tokens;

    logDebug('RESPONSES request', { rid, url, body: rBodyBase, conversationId });

    try {
      if (sseMode) {
        const response = await axios.post(url, rBodyBase, { headers, responseType: 'stream' });
        response.data.on('data', (chunk) => handleResponsesChunk(chunk, sendSSE));
        response.data.on('end', () => { logDebug('RESPONSES stream end', { rid, conversationId }); res.end(); });
        response.data.on('error', (e) => { logWarn('RESPONSES stream error', { rid, err: e.message, conversationId }); sendSSE({ type:'error', message: e.message }); res.end(); });
      } else {
        const { data } = await axios.post(url, rBodyBase, { headers });
        function extractText(x) {
          if (!x) return '';
          if (typeof x === 'string') return x;
          const direct =
            x.output_text?.join?.('') ||
            x.message?.content ||
            x.content;
          if (direct) return String(direct);
          const acc = [];
          const walk = (v) => {
            if (!v) return;
            if (typeof v === 'string') { acc.push(v); return; }
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (typeof v === 'object') {
              if (typeof v.text === 'string') acc.push(v.text);
              if (typeof v.content === 'string') acc.push(v.content);
              for (const k of Object.keys(v)) walk(v[k]);
            }
          };
          walk(x);
          return acc.join('');
        }
        const content = extractText(data);
        logDebug('RESPONSES non-stream result', { rid, empty: !content, topLevelKeys: Object.keys(data || {}), conversationId });
        if (!content) logWarn('No text extracted from /v1/responses', { rid, conversationId });
        res.json({ content });
      }
    } catch (err) {
      if (await isUnsupportedParamErrorAsync(err, 'temperature') && rBodyBase.temperature !== undefined) {
        logWarn('RESPONSES retry without temperature', { rid, conversationId });
        const rBodyRetry = { ...rBodyBase }; delete rBodyRetry.temperature;
        if (sseMode) {
          const response = await axios.post(url, rBodyRetry, { headers, responseType: 'stream' });
          response.data.on('data', (chunk) => handleResponsesChunk(chunk, sendSSE));
          response.data.on('end', () => { logDebug('RESPONSES stream end (retry)', { rid, conversationId }); res.end(); });
          response.data.on('error', (e) => { logWarn('RESPONSES stream error (retry)', { rid, err: e.message, conversationId }); sendSSE({ type:'error', message: e.message }); res.end(); });
        } else {
          const { data } = await axios.post(url, rBodyRetry, { headers });
          const content = data?.output_text?.join?.('') || data?.message?.content || data?.content || '';
          res.json({ content });
        }
        return;
      }
      const message = await extractErrAsync(err);
      sendSSE({ type:'error', message }); try { res.end(); } catch {}
    }
    return;
  }

  const url = `${base}/api/v1/chat/completions`;
  const body = { model, messages, stream: sseMode };
  if (typeof temperature === 'number' && !Number.isNaN(temperature)) body.temperature = temperature;
  if (max_tokens && !isGpt5) {
    if (reasoning === true) body.max_completion_tokens = max_tokens;
    else body.max_tokens = max_tokens;
  }

  logDebug('CHAT.COMPLETIONS request', { rid, url, body, conversationId });

  if (sseMode) {
    const response = await axios.post(url, body, { headers, responseType: 'stream' });
    response.data.on('data', (chunk) => handleChatCompletionsChunk(chunk, sendSSE));
    response.data.on('end', () => { logDebug('CHAT stream end', { rid, conversationId }); res.end(); });
    response.data.on('error', (e) => { logWarn('CHAT stream error', { rid, err: e.message, conversationId }); sendSSE({ type:'error', message: e.message }); res.end(); });
  } else {
    const { data } = await axios.post(url, body, { headers });
    const content = data.choices?.[0]?.message?.content || '';
    res.json({ content });
  }
}

module.exports = { handleOpenAICompat };
