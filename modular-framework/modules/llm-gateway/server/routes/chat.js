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
function prepareSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  return (payload) => {
    try {
      logDebug('GW -> client SSE', { payload });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      logWarn('GW SSE write error', { message: e.message });
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

async function dispatch(modelRow, reqBody, res, sse) {
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

  logInfo('GW LLM request', {
    provider_kind: modelRow.provider_kind,
    model: upstream.model,
    stream, useResponses: upstream.useResponses, reasoning: upstream.reasoning,
    messagesCount: Array.isArray(messages) ? messages.length : 0
  });
  logDebug('GW upstream payload', { upstream });

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
    logDebug('GW upstream delta', { len: typeof d === 'string' ? d.length : 0, data: d });
    if (typeof d === 'string' && d) completionText += d;
    sse?.({ type: 'delta', content: d });
  };
  const onDone = () => { logDebug('GW upstream done'); sse?.({ type: 'done' }); };
  const onError = (m) => { logWarn('GW upstream error', { message: m }); sse?.({ type: 'error', message: m }); };

  // OLLAMA
  if (modelRow.provider_kind === 'ollama') {
    if (stream) {
      await callOllama({ ...upstream, onDelta, onDone, onError });
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
      const { content } = await callOllama({ ...upstream, stream:false });
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
    await callOpenAICompat({
      ...upstream,
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
    const { content } = await callOpenAICompat({
      ...upstream, stream: false
    });
    completionText = content || '';
    logDebug('GW -> client JSON (openai-compat)', { contentHead: completionText.slice(0, 800) });
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

// Canonical gateway endpoint
router.post('/v1/chat', async (req, res) => {
  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? prepareSSE(res) : null;

  logInfo('GW /api/v1/chat <- client', {
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
    if (stream) await dispatch(modelRow, req.body, res, sse);
    else await dispatch(modelRow, req.body, res, null);
  } catch (err) {
    logError('GW /v1/chat error', { err: err?.message || String(err) });
    if (stream) { sse({ type:'error', message: err?.message || 'error' }); res.end(); }
    else res.status(500).json({ error: err?.message || 'error' });
  }
});

// Compatibility endpoint (accepts llm-chat-like body and maps to DB)
router.post('/compat/llm-chat', async (req, res) => {
  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? prepareSSE(res) : null;

  logInfo('GW /api/compat/llm-chat <- client', {
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

    if (stream) await dispatch(modelRow, req.body, res, sse);
    else await dispatch(modelRow, req.body, res, null);
  } catch (err) {
    logError('GW /compat/llm-chat error', { err: err?.message || String(err) });
    if (stream) { sse({ type:'error', message: err?.message || 'error' }); res.end(); }
    else res.status(500).json({ error: err?.message || 'error' });
  }
});

// NEW: workflows-friendly compat endpoint (SSE deltas as "llm.delta")
router.post('/compat/llm-workflows', async (req, res) => {
  const stream = !!(req.body?.stream ?? true);
  const write = stream ? prepareSSE(res) : null;

  logInfo('GW /api/compat/llm-workflows <- workflows', {
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
      write({ type: 'llm.delta', data: payload.content });
    } else if (payload.type === 'done') {
      write({ type: 'done' });
    } else if (payload.type === 'error') {
      write({ type: 'error', message: payload.message });
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

    if (stream) await dispatch(modelRow, req.body, res, sse);
    else await dispatch(modelRow, req.body, res, null);
  } catch (err) {
    logError('GW /compat/llm-workflows error', { err: err?.message || String(err) });
    if (stream) { sse({ type:'error', message: err?.message || 'error' }); res.end(); }
    else res.status(500).json({ error: err?.message || 'error' });
  }
});

module.exports = { router };
