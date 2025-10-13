const express = require('express');
const router = express.Router();
const { logInfo, logWarn, logError, logDebug } = require('../logger');
const {
  getModel, getModelByKey, getModelByName, logUsage,
  getTemplate, getTemplateByName, incrementTemplateUsage,
  getConversation, addConversationMessage
} = require('../db');
const { callOpenAICompat } = require('../providers/openaiCompat');
const { callOllama } = require('../providers/ollama');
const {
  pickEncodingForModel, countTextTokens, countChatTokens
} = require('../utils/tokens');
const { substituteTemplate } = require('./templates');
const telemetry = require('../telemetry/interactions');
const { SSEManager } = require('../utils/sseManager');
const { ProviderRouter } = require('../providers/providerRouter');

// Single provider router instance (used as a hint/fallback)
const providerRouter = new ProviderRouter();

function isGpt5ModelName(model) { 
  return /^gpt-5/i.test(model) || /^o5/i.test(model); 
}

function calcCost({ inTok, outTok, inPerM, outPerM }) {
  const inc = (Number(inTok) || 0) * (Number(inPerM) || 0) / 1_000_000;
  const outc = (Number(outTok) || 0) * (Number(outPerM) || 0) / 1_000_000;
  const total = inc + outc;
  return total > 0 ? Number(total.toFixed(6)) : null;
}

async function resolveModel(body) {
  if (body.modelId) return await getModel(Number(body.modelId));
  if (body.modelKey) return await getModelByKey(String(body.modelKey));
  if (body.model) return await getModelByName(String(body.model));
  return null;
}

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
  if (typeof data.text === 'string') return data.text;
  if (typeof data.content === 'string') return data.content;
  return '';
}

function sanitizeMessages(messages, maxChars = 8000) {
  const out = [];
  let remaining = maxChars;
  for (const m of Array.isArray(messages) ? messages : []) {
    if (remaining <= 0) break;
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter(p => typeof p?.text === 'string')
        .map(p => p.text)
        .join('');
    }
    if (text.length > remaining) text = text.slice(0, remaining);
    remaining -= text.length;
    out.push({ role: m.role || 'user', content: text });
  }
  return out;
}

// NEW: Apply template if specified
async function applyTemplate(body) {
  const { template_id, template_name, template_variables } = body;
  
  if (!template_id && !template_name) return body; // no template
  
  let tmpl;
  if (template_id) {
    tmpl = await getTemplate(Number(template_id));
  } else if (template_name) {
    tmpl = await getTemplateByName(template_name);
  }
  
  if (!tmpl) {
    throw new Error(`Template not found: ${template_id || template_name}`);
  }
  
  const vars = template_variables || {};
  const rendered = substituteTemplate(tmpl.template, vars);
  
  // Inject as user message (or replace last user message if specified)
  const messages = body.messages || [];
  if (body.replace_last_message && messages.length > 0) {
    messages[messages.length - 1].content = rendered;
  } else {
    messages.push({ role: 'user', content: rendered });
  }
  
  return {
    ...body,
    messages,
    _template_id: tmpl.id, // track for usage stats
    _template_name: tmpl.name
  };
}

/**
 * Dispatch upstream call and handle SSE via SSEManager
 * @param {*} modelRow resolved DB model row
 * @param {*} reqBody request body
 * @param {*} res express response (used for non-stream JSON only)
 * @param {*} sse SSEManager instance or null
 * @param {*} rid request id
 * @param {'default'|'workflows'} sseFormat SSE payload format
 */
async function dispatch(modelRow, reqBody, res, sse, rid, sseFormat = 'default') {
  let {
    messages = [], temperature, max_tokens, stream = true, 
    useResponses, reasoning, metadata, conversation_id,
    _template_id
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

  // Provider hint (via ProviderRouter) for logging/diagnostics
  let providerHint = null;
  try {
    const p = providerRouter.selectProvider(modelRow.model_name, modelRow.provider_kind);
    providerHint = p?.name || null;
  } catch {}

  logInfo('GW LLM request', { rid,
    provider_kind: modelRow.provider_kind,
    provider_hint: providerHint,
    model: upstream.model,
    stream, useResponses: upstream.useResponses, reasoning: upstream.reasoning,
    messagesCount: Array.isArray(messages) ? messages.length : 0,
    conversation_id: conversation_id || null,
    template_used: _template_id || null
  });

  const encName = pickEncodingForModel(modelRow.model_name);
  let promptChars = 0;
  try { promptChars = JSON.stringify(messages || []).length; } catch {}
  const inTok = countChatTokens(messages, encName);

  const metaBase = {
    ...(metadata || {}),
    gateway: 'llm-gateway',
    currency: modelRow.currency || 'USD',
    conversation_id: conversation_id || null,
    template_id: _template_id || null
  };

  let completionText = '';
  let lastPush = 0;
  const pushLive = () => {
    const now = Date.now();
    if (now - lastPush < 150) return;
    lastPush = now;
    telemetry.update(rid, { output: completionText });
  };

  const onDelta = (d) => {
    logDebug('GW upstream delta', { rid, len: typeof d === 'string' ? d.length : 0 });
    if (typeof d === 'string' && d) completionText += d;
    if (sse) {
      if (sseFormat === 'workflows') sse.send({ type: 'llm.delta', data: d });
      else sse.sendChunk({ content: d });
    }
    pushLive();
  };
  // We will complete when usage is computed; upstream onDone acknowledged silently
  const onDone = () => { logDebug('GW upstream done', { rid }); };
  const onError = (m) => { 
    logWarn('GW upstream error', { rid, message: m }); 
    if (sse) sse.error(new Error(m));
  };

  // Helper to finalize usage + SSE completion
  async function finalizeAndComplete(outTextForAccounting) {
    telemetry.update(rid, { output: outTextForAccounting });
    const completionChars = outTextForAccounting.length;
    const outTok = countTextTokens(outTextForAccounting, encName);
    const cost = calcCost({
      inTok, outTok,
      inPerM: modelRow.input_cost_per_million,
      outPerM: modelRow.output_cost_per_million
    });
    await logUsage({
      provider_id: modelRow.provider_id,
      model_id: modelRow.id,
      conversation_id: conversation_id || metaBase.conversation_id || null,
      input_tokens: inTok,
      output_tokens: outTok,
      prompt_chars: promptChars,
      completion_chars: completionChars,
      cost,
      meta: metaBase
    });

    if (_template_id) {
      await incrementTemplateUsage(_template_id, inTok + outTok, cost);
    }
    
    if (conversation_id) {
      await addConversationMessage({
        conversation_id,
        role: 'assistant',
        content: outTextForAccounting,
        tokens: outTok,
        cost
      });
    }

    telemetry.finish(rid, {
      inTok, outTok, cost,
      model: modelRow.model_name,
      provider: modelRow.provider_kind,
      conversation_id: conversation_id || null
    });

    if (sse) {
      // Provide usage in completion
      sse.complete({
        prompt_tokens: inTok,
        completion_tokens: outTok,
        total_tokens: inTok + outTok
      });
    }
  }

  // OLLAMA
  if (modelRow.provider_kind === 'ollama') {
    if (stream) {
      await callOllama({ ...upstream, onDelta, onDone, onError, rid });
      await finalizeAndComplete(completionText);
      return;
    } else {
      const { content } = await callOllama({ ...upstream, stream:false, rid });
      const text = content || '';
      await finalizeAndComplete(text);
      return res.json({ content: text });
    }
  }

  // OpenAI / OpenAI-compatible
  if (stream) {
    await callOpenAICompat({ ...upstream, rid, onDelta, onDone, onError });
    await finalizeAndComplete(completionText);
  } else {
    const respPayload = await callOpenAICompat({ ...upstream, rid, stream: false });

    if (upstream.useResponses) {
      const textForAccounting = pickContentFromResponses(respPayload) || '';
      await finalizeAndComplete(textForAccounting);
      return res.json(respPayload);
    }

    const completionTextLocal = (respPayload && respPayload.content) || '';
    await finalizeAndComplete(completionTextLocal);
    return res.json({ content: completionTextLocal });
  }
}

// Canonical gateway endpoint
router.post('/v1/chat', async (req, res) => {
  const rid = req.id;
  
  // NEW: Check for dry-run mode
  if (req.query.dry_run === '1' || req.body?.dry_run === true) {
    logInfo('GW /api/v1/chat DRY-RUN', { rid, ip: req.ip });
    
    try {
      const body = await applyTemplate(req.body);
      const modelRow = await resolveModel(body);
      
      if (!modelRow) {
        return res.status(400).json({ 
          error: 'Model not configured',
          dry_run: true 
        });
      }
      
      const messages = body.messages || [];
      const encName = pickEncodingForModel(modelRow.model_name);
      const inTok = countChatTokens(messages, encName);
      const estOutTok = body.max_tokens || Math.min(inTok * 2, 1000);
      
      const cost = calcCost({
        inTok,
        outTok: estOutTok,
        inPerM: modelRow.input_cost_per_million,
        outPerM: modelRow.output_cost_per_million
      });
      
      return res.json({
        ok: true,
        dry_run: true,
        model: {
          id: modelRow.id,
          name: modelRow.model_name,
          display_name: modelRow.display_name
        },
        token_estimate: {
          input_tokens: inTok,
          estimated_output_tokens: estOutTok
        },
        cost_estimate: {
          total_cost: cost,
          currency: modelRow.currency || 'USD'
        },
        template_used: body._template_name || null,
        message_count: messages.length,
        note: 'Dry-run mode: no LLM call was made'
      });
    } catch (err) {
      return res.status(400).json({ 
        error: err.message,
        dry_run: true 
      });
    }
  }

  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? new SSEManager(res, rid) : null;
  if (sse) sse.init();

  logInfo('GW /api/v1/chat <- client', { rid,
    ip: req.ip,
    stream,
    modelId: req.body?.modelId,
    modelKey: req.body?.modelKey,
    model: req.body?.model,
    conversation_id: req.body?.conversation_id,
    template_id: req.body?.template_id,
    template_name: req.body?.template_name
  });

  try {
    // Apply template if specified
    const body = await applyTemplate(req.body);
    
    telemetry.start({
      id: rid,
      model: body?.model || body?.modelKey || body?.modelId || null,
      provider: null,
      stream,
      ip: req.ip,
      started_at: new Date().toISOString(),
      meta: {
        conversation_id: body?.conversation_id || null,
        template_id: body?._template_id || null
      }
    });
    telemetry.update(rid, {
      messages: sanitizeMessages(body?.messages)
    });

    const modelRow = await resolveModel(body);
    if (!modelRow) {
      if (sse) sse.error(new Error('Model not configured in gateway.'));
      telemetry.fail(rid, 'Model not configured');
      return stream ? undefined : res.status(400).json({ error: 'Model not configured' });
    }
    
    telemetry.update(rid, {
      model: modelRow.model_name,
      provider: modelRow.provider_kind
    });
    
    if (stream) await dispatch(modelRow, body, res, sse, rid, 'default');
    else await dispatch(modelRow, body, res, null, rid, 'default');
  } catch (err) {
    logError('GW /v1/chat error', { rid, err: err?.message || String(err) });
    if (stream) { sse?.error(new Error(err?.message || 'error')); }
    else res.status(500).json({ error: err?.message || 'error' });
    telemetry.fail(rid, err?.message || 'error');
  }
});

// Compatibility endpoint (accepts llm-chat-like body)
router.post('/compat/llm-chat', async (req, res) => {
  const rid = req.id;
  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? new SSEManager(res, rid) : null;
  if (sse) sse.init();

  logInfo('GW /api/compat/llm-chat <- client', { rid, ip: req.ip, stream });

  try {
    const body = await applyTemplate(req.body);
    
    telemetry.start({
      id: rid, model: body?.model || null, provider: null, stream, ip: req.ip,
      started_at: new Date().toISOString(),
      meta: { conversation_id: body?.conversation_id || null }
    });
    telemetry.update(rid, { messages: sanitizeMessages(body?.messages) });

    const modelRow = await resolveModel(body);
    if (!modelRow) {
      if (sse) sse.error(new Error('Model not found in gateway.'));
      telemetry.fail(rid, 'Model not found');
      return stream ? undefined : res.status(400).json({ error: 'Model not found' });
    }

    telemetry.update(rid, { model: modelRow.model_name, provider: modelRow.provider_kind });

    if (stream) await dispatch(modelRow, body, res, sse, rid, 'default');
    else await dispatch(modelRow, body, res, null, rid, 'default');
  } catch (err) {
    logError('GW /compat/llm-chat error', { rid, err: err?.message || String(err) });
    if (stream) { sse?.error(new Error(err?.message || 'error')); }
    else res.status(500).json({ error: err?.message || 'error' });
    telemetry.fail(rid, err?.message || 'error');
  }
});

// Workflows-friendly compat endpoint
router.post('/compat/llm-workflows', async (req, res) => {
  const rid = req.id;
  const stream = !!(req.body?.stream ?? true);
  const sse = stream ? new SSEManager(res, rid) : null;
  if (sse) sse.init();

  logInfo('GW /api/compat/llm-workflows <- workflows', { rid, ip: req.ip, stream });

  try {
    const body = await applyTemplate(req.body);
    
    telemetry.start({
      id: rid,
      model: body?.model || body?.modelKey || body?.modelId || null,
      stream, ip: req.ip,
      started_at: new Date().toISOString(),
      meta: { conversation_id: body?.conversation_id || null }
    });
    telemetry.update(rid, { messages: sanitizeMessages(body?.messages) });

    const modelRow = await resolveModel(body);

    if (!modelRow) {
      if (stream) { sse?.error(new Error('Model not found')); }
      telemetry.fail(rid, 'Model not found');
      return !stream && res.status(400).json({ error: 'Model not found' });
    }

    telemetry.update(rid, { model: modelRow.model_name, provider: modelRow.provider_kind });

    if (stream) await dispatch(modelRow, body, res, sse, rid, 'workflows');
    else await dispatch(modelRow, body, res, null, rid, 'workflows');
  } catch (err) {
    logError('GW /compat/llm-workflows error', { rid, err: err?.message || String(err) });
    if (stream) { sse?.error(new Error(err?.message || 'error')); }
    else res.status(500).json({ error: err?.message || 'error' });
    telemetry.fail(rid, err?.message || 'error');
  }
});

module.exports = { router };
