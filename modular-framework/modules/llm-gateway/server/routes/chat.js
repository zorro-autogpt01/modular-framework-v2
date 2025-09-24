const express = require('express');
const router = express.Router();
const { logInfo, logWarn, logError, logDebug } = require('../logger');
const {
  getModel, getModelByKey, getModelByName, logUsage
} = require('../db');
const { callOpenAICompat } = require('../providers/openaiCompat');
const { callOllama } = require('../providers/ollama');
const {
  pickEncodingForModel, countTextTokens, countChatTokens
} = require('../utils/tokens');

// SSE helper
function prepareSSE(res, rid) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // helpful behind some proxies
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Track SSE connection lifecycle once
  let ended = false;
  const onEnd = (kind) => {
    if (ended) return;
    ended = true;
    logInfo('GW /v1/chat finished', { rid, kind });
  };
  res.on('close', () => onEnd('close'));
  res.on('finish', () => onEnd('finish'));

  // Return a sender
  return (payload) => {
    try {
      logDebug('GW -> client SSE', { rid, payload });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      logWarn('GW SSE write error', { rid, message: e.message });
    }
  };
}

function isGpt5ModelName(model) { return /^gpt-5/i.test(model) || /^o5/i.test(model); }

function calcCost({ inTok, outTok, inPerM, outPerM }) {
  const inc = (Number(inTok) || 0) * (Number(inPerM) || 0) / 1_000_000;
  const outc = (Number(outTok) || 0) * (Number(outPerM) || 0) / 1_000_000;
  const total = inc + outc;
  return total > 0 ? Number(total.toFixed(6)) : null;
}

async function resolveModel(body) {
  // Resolve precedence: modelId > modelKey > modelName
  if (body.modelId) return await getModel(Number(body.modelId));
  if (body.modelKey) return await getModelByKey(String(body.modelKey));
  if (body.model) return await getModelByName(String(body.model));
  return null;
}

/**
 * Extracts plain text from an OpenAI Responses API payload for accounting.
 * Looks in: output[].message.content[].output_text.text (preferred),
 * then content[].text or content[].content as fallbacks.
 */
function pickContentFromResponses(data) {
  if (!data || typeof data !== 'object') return '';
  if (Array.isArray(data.output)) {
    const msg = data.output.find(p => p?.type === 'message');
    const parts = msg?.content;
    if (Array.isArray(parts)) {
      const ot = parts.find(p => p?.type === 'output_text' && typeof p?.text === 'string');
      if (ot?.text) return ot.text;
      if (typeof parts[0]?.text === 'string') return parts[0].text;
      if (typeof parts[0]?.content === 'string') return parts[0].content;
    }
  }
  // Some providers may flatten to data.text or data.content
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string') return data.content;
  return '';
}

async function dispatch(modelRow, reqBody, res, sse, rid) {
  const {
    messages = [], temperature, max_tokens, stream = true, useResponses, reasoning, metadata
  } = reqBody || {};

  const upstream = {
    baseUrl: modelRow.provider_base_url,
    apiKey: modelRow.provider_api_key,
    model: modelRow.model_name,
    messages, temperature, max_tokens,
    useResponses: (modelRow.mode === 'responses') ||
                  (!!useResponses) ||
                  (modelRow.supports_responses && isGpt5ModelName(modelRow.model_name)) ||
                  isGpt5ModelName(modelRow.model_name),
    reasoning: reasoning || modelRow.supports_reasoning || false,
    stream
  };

  logInfo('GW LLM request', { rid,
    provider_kind: modelRow.provider_kind,
    model: upstream.model,
    stream, useResponses: upstream.useResponses, reasoning: upstream.reasoning,
    messagesCount: Array.isArray(messages) ? messages.length : 0
  });
  // Be careful not to log secrets here:
  logDebug('GW upstream payload', { rid, upstream: { ...upstream, apiKey: upstream.apiKey ? '***REDACTED***' : undefined } });

  // Tokenization + cost prep
  const encName = pickEncodingForModel(modelRow.model_name);
  let promptChars = 0;
  try { promptChars = JSON.stringify(messages || []).length; } catch {}
  const inTok = countChatTokens(messages, encName);

  const metaBase = {
    ...(metadata || {}),
    gateway: 'llm-gateway',
    currency: modelRow.currency || 'USD'
  };

  let completionText = '';

  const onDelta = (d) => {
    logDebug('GW upstream delta', { rid, len: typeof d === 'string' ? d.length : 0, data: d });
    if (typeof d === 'string' && d) completionText += d;
    sse?.({ type: 'delta', content: d });
  };
  const onDone = () => { logDebug('GW upstream done', { rid }); sse?.({ type: 'done' }); };
  const onError = (m) => { logWarn('GW upstream error', { rid, message: m }); sse?.({ type: 'error', message: m }); };

  // OLLAMA
  if (modelRow.provider_kind === 'ollama') {
    if (stream) {
      await callOllama({ ...upstream, onDelta, onDone, onError, rid });
      const completionChars = completionText.length;
      const outTok = countTextTokens(completionText, encName);
      const cost = calcCost({
        inTok, outTok,
        inPerM: modelRow.input_cost_per_million,
        outPerM: modelRow.output_cost_per_million
      });
      await logUsage({
        provider_id: modelRow.provider_id,
        model_id: modelRow.id,
        conversation_id: metaBase.conversation_id || metaBase.conversationId || null,
        input_tokens: inTok,
        output_tokens: outTok,
        prompt_chars: promptChars,
        completion_chars: completionChars,
        cost,
        meta: metaBase
      });
      return;
    } else {
      const { content } = await callOllama({ ...upstream, stream:false, rid });
      completionText = content || '';
      logDebug('GW -> client JSON (ollama)', { contentHead: completionText.slice(0, 800) });
      const completionChars = completionText.length;
      const outTok = countTextTokens(completionText, encName);
      const cost = calcCost({
        inTok, outTok,
        inPerM: modelRow.input_cost_per_million,
        outPerM: modelRow.output_cost_per_million
      });
      await logUsage({
        provider_id: modelRow.provider_id,
        model_id: modelRow.id,
        conversation_id: metaBase.conversation_id || metaBase.conversationId || null,
        input_tokens: inTok,
        output_tokens: outTok,
        prompt_chars: promptChars,
        completion_chars: completionChars,
        cost,
        meta: metaBase
      });
      return res.json({ content: completionText });
    }
  }

  // OpenAI / OpenAI-compatible
  if (stream) {
    // Streaming path unchanged
    await callOpenAICompat({
      ...upstream, rid,
      onDelta, onDone, onError
    });
    const completionChars = completionText.length;
    const outTok = countTextTokens(completionText, encName);
    const cost = calcCost({
      inTok, outTok,
      inPerM: modelRow.input_cost_per_million,
      outPerM: modelRow.output_cost_per_million
    });
    await logUsage({
      provider_id: modelRow.provider_id,
      model_id: modelRow.id,
      conversation_id: metaBase.conversation_id || metaBase.conversationId || null,
      input_tokens: inTok,
      output_tokens: outTok,
      prompt_chars: promptChars,
      completion_chars: completionChars,
      cost,
      meta: metaBase
    });
  } else {
    // NON-STREAM: Option A — pass through Responses API when in use
    const respPayload = await callOpenAICompat({
      ...upstream, rid, stream: false
    });

    if (upstream.useResponses) {
      // Extract text only for accounting; return full payload to client.
      const textForAccounting = pickContentFromResponses(respPayload) || '';
      const completionChars = textForAccounting.length;
      const outTok = countTextTokens(textForAccounting, encName);
      const cost = calcCost({
        inTok, outTok,
        inPerM: modelRow.input_cost_per_million,
        outPerM: modelRow.output_cost_per_million
      });

      logDebug('GW -> client JSON (responses-pass-thru)', {
        head: JSON.stringify(respPayload).slice(0, 800)
      });

      await logUsage({
        provider_id: modelRow.provider_id,
        model_id: modelRow.id,
        conversation_id: metaBase.conversation_id || metaBase.conversationId || null,
        input_tokens: inTok,
        output_tokens: outTok,
        prompt_chars: promptChars,
        completion_chars: completionChars,
        cost,
        meta: metaBase
      });

      return res.json(respPayload);
    }

    // Legacy chat-completions or compat providers: keep returning { content }
    const completionTextLocal = (respPayload && respPayload.content) || '';
    logDebug('GW -> client JSON (openai-compat)', { contentHead: completionTextLocal.slice(0, 800) });
    const completionChars = completionTextLocal.length;
    const outTok = countTextTokens(completionTextLocal, encName);
    const cost = calcCost({
      inTok, outTok,
      inPerM: modelRow.input_cost_per_million,
      outPerM: modelRow.output_cost_per_million
    });
    await logUsage({
      provider_id: modelRow.provider_id,
      model_id: modelRow.id,
      conversation_id: metaBase.conversation_id || metaBase.conversationId || null,
      input_tokens: inTok,
      output_tokens: outTok,
      prompt_chars: promptChars,
      completion_chars: completionChars,
      cost,
      meta: metaBase
    });
    return res.json({ content: completionTextLocal });
  }
}

// Canonical gateway endpoint
router.post('/v1/chat', async (req, res) => {  const rid = req.id;

  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? prepareSSE(res, rid) : null;

  logInfo('GW /api/v1/chat <- client', { rid,
    ip: req.ip,
    stream,
    modelId: req.body?.modelId,
    modelKey: req.body?.modelKey,
    model: req.body?.model,
    temperature: req.body?.temperature,
    max_tokens: req.body?.max_tokens,
    messages: req.body?.messages
  });

  try {
    const modelRow = await resolveModel(req.body || {});
    if (!modelRow) {
      if (sse) sse({ type:'error', message: 'Model not configured in gateway.' });
      return stream ? res.end() : res.status(400).json({ error: 'Model not configured' });
    }
    if (stream) await dispatch(modelRow, req.body, res, sse, rid);
    else await dispatch(modelRow, req.body, res, null, rid);
  } catch (err) {
    logError('GW /v1/chat error', { rid, err: err?.message || String(err) });
    if (stream) { sse({ type:'error', message: err?.message || 'error' }); res.end(); }
    else res.status(500).json({ error: err?.message || 'error' });
  }
});

// Compatibility endpoint (accepts llm-chat-like body and maps to DB)
router.post('/compat/llm-chat', async (req, res) => {  const rid = req.id;

  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? prepareSSE(res, rid) : null;

  logInfo('GW /api/compat/llm-chat <- client', { rid,
    ip: req.ip,
    stream,
    model: req.body?.model,
    temperature: req.body?.temperature,
    max_tokens: req.body?.max_tokens,
    messages: req.body?.messages
  });

  try {
    let modelRow = null;

    // Try to resolve by explicit llm-chat fields
    const modelName = req.body?.model;
    if (modelName) modelRow = await getModelByName(modelName);

    if (!modelRow) {
      if (sse) sse({ type:'error', message: 'Model not found in gateway. Please configure it.' });
      return stream ? res.end() : res.status(400).json({ error: 'Model not found' });
    }

    if (stream) await dispatch(modelRow, req.body, res, sse, rid);
    else await dispatch(modelRow, req.body, res, null, rid);
  } catch (err) {
    logError('GW /compat/llm-chat error', { rid, err: err?.message || String(err) });
    if (stream) { sse({ type:'error', message: err?.message || 'error' }); res.end(); }
    else res.status(500).json({ error: err?.message || 'error' });
  }
});

// NEW: workflows-friendly compat endpoint (SSE deltas as "llm.delta")
router.post('/compat/llm-workflows', async (req, res) => {  const rid = req.id;

  const stream = !!(req.body?.stream ?? true);
  const write = stream ? prepareSSE(res, rid) : null;

  logInfo('GW /api/compat/llm-workflows <- workflows', { rid,
    ip: req.ip,
    stream,
    modelId: req.body?.modelId,
    modelKey: req.body?.modelKey,
    model: req.body?.model,
    temperature: req.body?.temperature,
    max_tokens: req.body?.max_tokens,
    messages: req.body?.messages
  });

  // map standard payloads to workflows SSE schema
  const sse = stream ? (payload) => {
    if (!payload) return;
    if (payload.type === 'delta') {
      write({ type: 'llm.delta', data: payload.content, rid });
    } else if (payload.type === 'done') {
      write({ type: 'done', rid });
    } else if (payload.type === 'error') {
      write({ type: 'error', message: payload.message, rid });
    } else {
      write(payload);
    }
  } : null;

  try {
    const modelRow =
      (req.body?.modelId && await getModel(Number(req.body.modelId))) ||
      (req.body?.modelKey && await getModelByKey(String(req.body.modelKey))) ||
      (req.body?.model && await getModelByName(String(req.body.model))) ||
      null;

    if (!modelRow) {
      if (stream) { sse({ type:'error', message:'Model not found' }); return res.end(); }
      return res.status(400).json({ error: 'Model not found' });
    }

    if (stream) await dispatch(modelRow, req.body, res, sse, rid);
    else await dispatch(modelRow, req.body, res, null, rid);
  } catch (err) {
    logError('GW /compat/llm-workflows error', { rid, err: err?.message || String(err) });
    if (stream) { sse({ type:'error', message: err?.message || 'error' }); res.end(); }
    else res.status(500).json({ error: err?.message || 'error' });
  }
});

module.exports = { router };
