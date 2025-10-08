const express = require('express');
const router = express.Router();
const { ah } = require('../utils/asyncHandler');
const { validate, num, bool } = require('../utils/validate');
const { getUsageById, getModel } = require('../db');
const { logInfo, logDebug, logWarn } = require('../logger');
const { callOpenAICompat } = require('../providers/openaiCompat');
const { callOllama } = require('../providers/ollama');
const { countChatTokens, pickEncodingForModel } = require('../utils/tokens');

// Replay a request from usage log (for debugging)
router.post('/debug/replay/:usage_id', ah(async (req, res) => {
  const rid = req.id;
  logInfo('GW /api/debug/replay', { 
    usage_id: req.params.usage_id,
    rid,
    ip: req.ip 
  });

  const usageRecord = await getUsageById(Number(req.params.usage_id));
  if (!usageRecord) {
    return res.status(404).json({ error: 'Usage record not found' });
  }

  // Extract original request details from meta
  const meta = usageRecord.meta || {};
  const messages = meta.messages || [];
  
  if (!messages.length) {
    return res.status(400).json({ 
      error: 'No messages found in usage record. Cannot replay.' 
    });
  }

  const modelRow = await getModel(usageRecord.model_id);
  if (!modelRow) {
    return res.status(404).json({ 
      error: 'Model configuration not found' 
    });
  }

  // Replay with same parameters (but don't stream for simplicity)
  try {
    logDebug('GW replay request', { rid, usage_id: usageRecord.id });

    let content = '';
    
    if (modelRow.provider_kind === 'ollama') {
      const result = await callOllama({
        baseUrl: modelRow.provider_base_url,
        apiKey: modelRow.provider_api_key,
        model: modelRow.model_name,
        messages,
        temperature: meta.temperature,
        stream: false,
        rid
      });
      content = result.content;
    } else {
      const result = await callOpenAICompat({
        baseUrl: modelRow.provider_base_url,
        apiKey: modelRow.provider_api_key,
        model: modelRow.model_name,
        messages,
        temperature: meta.temperature,
        max_tokens: meta.max_tokens,
        useResponses: modelRow.mode === 'responses',
        reasoning: modelRow.supports_reasoning,
        stream: false,
        rid
      });
      content = result.content;
    }

    res.json({
      ok: true,
      replayed: true,
      original_usage_id: usageRecord.id,
      original_cost: usageRecord.cost,
      response: content,
      note: 'This is a replay. New usage was not logged.'
    });
  } catch (err) {
    logWarn('GW replay failed', { rid, error: err.message });
    res.status(500).json({ 
      error: 'Replay failed', 
      message: err.message 
    });
  }
}));

// Dry-run mode: validate request and estimate cost without calling LLM
router.post('/debug/dry-run', ah(async (req, res) => {
  const rid = req.id;
  logInfo('GW /api/debug/dry-run', { 
    rid,
    body: req.body,
    ip: req.ip 
  });

  const data = validate(req.body || {}, {
    model_id: num().optional(),
    model: num().optional(), // allow either format
    messages: validate.any,
    temperature: num().optional(),
    max_tokens: num().optional()
  });

  // Resolve model
  const modelId = data.model_id || data.model;
  if (!modelId) {
    return res.status(400).json({ error: 'model_id or model required' });
  }

  const modelRow = await getModel(Number(modelId));
  if (!modelRow) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const messages = data.messages || [];
  const encName = pickEncodingForModel(modelRow.model_name);
  
  // Calculate token counts
  const inputTokens = countChatTokens(messages, encName);
  
  // Estimate output tokens (use max_tokens or reasonable default)
  const estimatedOutputTokens = data.max_tokens || 
    Math.min(inputTokens * 2, 1000);

  // Calculate estimated cost
  const inputCost = (inputTokens * modelRow.input_cost_per_million) / 1_000_000;
  const outputCost = (estimatedOutputTokens * modelRow.output_cost_per_million) / 1_000_000;
  const totalCost = inputCost + outputCost;

  logDebug('GW dry-run complete', { 
    rid, 
    inputTokens, 
    estimatedOutputTokens, 
    totalCost 
  });

  res.json({
    ok: true,
    dry_run: true,
    model: {
      id: modelRow.id,
      name: modelRow.model_name,
      display_name: modelRow.display_name
    },
    validation: {
      valid: true,
      message_count: messages.length
    },
    token_estimate: {
      input_tokens: inputTokens,
      estimated_output_tokens: estimatedOutputTokens,
      encoding: encName
    },
    cost_estimate: {
      input_cost: Number(inputCost.toFixed(6)),
      output_cost: Number(outputCost.toFixed(6)),
      total_cost: Number(totalCost.toFixed(6)),
      currency: modelRow.currency || 'USD'
    },
    note: 'This is a dry-run. No LLM call was made.'
  });
}));

// Validate request format without any processing
router.post('/debug/validate', ah(async (req, res) => {
  const rid = req.id;
  logInfo('GW /api/debug/validate', { 
    rid,
    ip: req.ip 
  });

  const errors = [];
  const warnings = [];

  // Check basic structure
  if (!req.body) {
    errors.push('Request body is empty');
    return res.status(400).json({ valid: false, errors, warnings });
  }

  const body = req.body;

  // Check model specification
  if (!body.model_id && !body.model && !body.modelKey && !body.modelName) {
    errors.push('No model specified. Use model_id, model, modelKey, or modelName');
  }

  // Check messages
  if (!body.messages) {
    errors.push('No messages array provided');
  } else if (!Array.isArray(body.messages)) {
    errors.push('messages must be an array');
  } else if (body.messages.length === 0) {
    warnings.push('messages array is empty');
  } else {
    // Validate message structure
    body.messages.forEach((msg, idx) => {
      if (!msg.role) {
        errors.push(`Message ${idx}: missing role`);
      }
      if (!msg.content && msg.role !== 'tool') {
        warnings.push(`Message ${idx}: missing content`);
      }
    });
  }

  // Check parameters
  if (body.temperature !== undefined) {
    const temp = Number(body.temperature);
    if (isNaN(temp) || temp < 0 || temp > 2) {
      warnings.push('temperature should be between 0 and 2');
    }
  }

  if (body.max_tokens !== undefined) {
    const max = Number(body.max_tokens);
    if (isNaN(max) || max < 1) {
      errors.push('max_tokens must be a positive number');
    }
  }

  logDebug('GW validate complete', { 
    rid, 
    valid: errors.length === 0,
    errorCount: errors.length,
    warningCount: warnings.length
  });

  res.json({
    valid: errors.length === 0,
    errors,
    warnings,
    structure: {
      has_model: !!(body.model_id || body.model || body.modelKey),
      has_messages: Array.isArray(body.messages),
      message_count: Array.isArray(body.messages) ? body.messages.length : 0,
      has_temperature: body.temperature !== undefined,
      has_max_tokens: body.max_tokens !== undefined,
      stream: body.stream !== false
    }
  });
}));

// Test endpoint connectivity
router.get('/debug/test-provider/:id', ah(async (req, res) => {
  const rid = req.id;
  logInfo('GW /api/debug/test-provider', { 
    provider_id: req.params.id,
    rid,
    ip: req.ip 
  });

  const { getProvider } = require('../db');
  const provider = await getProvider(Number(req.params.id));
  
  if (!provider) {
    return res.status(404).json({ error: 'Provider not found' });
  }

  try {
    // Simple connectivity test (try to hit base URL)
    const testUrl = `${provider.base_url.replace(/\/$/, '')}/models`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
        ...( provider.headers || {})
      },
      signal: controller.signal
    }).finally(() => clearTimeout(timeout));

    res.json({
      ok: true,
      provider: {
        id: provider.id,
        name: provider.name,
        kind: provider.kind
      },
      test_url: testUrl,
      reachable: response.ok,
      status: response.status,
      message: response.ok ? 'Provider is reachable' : 'Provider returned error'
    });
  } catch (err) {
    logWarn('GW provider test failed', { rid, error: err.message });
    res.json({
      ok: false,
      provider: {
        id: provider.id,
        name: provider.name,
        kind: provider.kind
      },
      reachable: false,
      error: err.message,
      message: 'Provider is unreachable or misconfigured'
    });
  }
}));

module.exports = { router };