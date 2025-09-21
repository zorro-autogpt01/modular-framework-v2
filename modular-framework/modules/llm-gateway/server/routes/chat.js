const express = require('express');
const router = express.Router();
const { logInfo, logWarn, logError } = require('../logger');
const {
  getModel, getModelByKey, getModelByName, logUsage
} = require('../db');
const { callOpenAICompat } = require('../providers/openaiCompat');
const { callOllama } = require('../providers/ollama');

// SSE helper
function prepareSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  return (payload) => { try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch {} };
}

function isGpt5ModelName(model) { return /^gpt-5/i.test(model) || /^o5/i.test(model); }
function estimateTokensFromChars(chars) {
  // very rough heuristic: 4 chars ≈ 1 token
  return Math.max(1, Math.round((chars || 0) / 4));
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
    stream, useResponses: upstream.useResponses, reasoning: upstream.reasoning
  });

  const onDelta = (d) => sse?.({ type: 'delta', content: d });
  const onDone = () => sse?.({ type: 'done' });
  const onError = (m) => sse?.({ type: 'error', message: m });

  const metaBase = { ...(metadata || {}), gateway: 'llm-gateway' };

  let promptChars = 0;
  try {
    promptChars = JSON.stringify(messages || []).length;
  } catch {}

  if (modelRow.provider_kind === 'ollama') {
    if (stream) {
      await callOllama({ ...upstream, onDelta, onDone, onError });
      // no usage info from stream; log rough estimate with zero cost
      const completionChars = 0; // unknown
      await logUsage({
        provider_id: modelRow.provider_id,
        model_id: modelRow.id,
        conversation_id: metaBase.conversationId || null,
        input_tokens: estimateTokensFromChars(promptChars),
        output_tokens: null,
        prompt_chars: promptChars,
        completion_chars: completionChars,
        cost: null,
        meta: metaBase
      });
      return;
    } else {
      const { content } = await callOllama({ ...upstream, stream:false });
      await logUsage({
        provider_id: modelRow.provider_id,
        model_id: modelRow.id,
        conversation_id: metaBase.conversationId || null,
        input_tokens: estimateTokensFromChars(promptChars),
        output_tokens: estimateTokensFromChars((content || '').length),
        prompt_chars: promptChars,
        completion_chars: (content || '').length,
        cost: null,
        meta: metaBase
      });
      return res.json({ content });
    }
  }

  // OpenAI/OpenAI-compatible
  if (stream) {
    await callOpenAICompat({
      ...upstream,
      onDelta, onDone, onError
    });
    await logUsage({
      provider_id: modelRow.provider_id,
      model_id: modelRow.id,
      conversation_id: metaBase.conversationId || null,
      input_tokens: estimateTokensFromChars(promptChars),
      output_tokens: null,
      prompt_chars: promptChars,
      completion_chars: null,
      cost: null,
      meta: metaBase
    });
  } else {
    const { content } = await callOpenAICompat({
      ...upstream, stream: false
    });
    await logUsage({
      provider_id: modelRow.provider_id,
      model_id: modelRow.id,
      conversation_id: metaBase.conversationId || null,
      input_tokens: estimateTokensFromChars(promptChars),
      output_tokens: estimateTokensFromChars((content || '').length),
      prompt_chars: promptChars,
      completion_chars: (content || '').length,
      cost: null,
      meta: metaBase
    });
    return res.json({ content });
  }
}

// Canonical gateway endpoint
router.post('/v1/chat', async (req, res) => {
  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? prepareSSE(res) : null;

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

// Compatibility endpoint (accepts llm-chat body and maps to DB)
router.post('/compat/llm-chat', async (req, res) => {
  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? prepareSSE(res) : null;

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

module.exports = { router };

