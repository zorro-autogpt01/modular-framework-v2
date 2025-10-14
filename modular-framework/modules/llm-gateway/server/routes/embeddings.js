// modular-framework/modules/llm-gateway/server/routes/embeddings.js
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { ah } = require('../utils/asyncHandler');
const { validate, str, num, obj, oneOf } = require('../utils/validate');
const { logUsage, getModel, getModelByKey } = require('../db');
const { logInfo, logDebug, logError } = require('../logger');

/**
 * Calculate cost for embeddings based on token usage
 * 
 * Prices as of 2025 (update as needed):
 * - text-embedding-3-small: $0.02 per 1M tokens
 * - text-embedding-3-large: $0.13 per 1M tokens  
 * - text-embedding-ada-002: $0.10 per 1M tokens
 */
function estimateEmbeddingCost(modelName, tokens) {
  const costsPerMillion = {
    'text-embedding-3-small': 0.02,
    'text-embedding-3-large': 0.13,
    'text-embedding-ada-002': 0.10,
  };
  
  const baseName = modelName.toLowerCase();
  const costPerToken = (costsPerMillion[baseName] || 0.02) / 1_000_000;
  return tokens * costPerToken;
}

/**
 * Call OpenAI embeddings API
 */
async function callOpenAIEmbeddings({ apiKey, baseUrl, model, input, encoding_format, dimensions }) {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/embeddings`;
  
  const body = {
    model,
    input,
    encoding_format: encoding_format || 'float'
  };
  
  if (dimensions) {
    body.dimensions = dimensions;
  }

  logDebug('GW EMBEDDINGS request', { url, model, inputType: Array.isArray(input) ? 'array' : 'string' });

  try {
    const response = await axios.post(url, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    });

    return response.data;
  } catch (error) {
    logError('GW EMBEDDINGS error', { 
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });
    throw error;
  }
}

/**
 * POST /api/embeddings
 * 
 * Generate embeddings using configured provider
 * Accepts single text or batch of texts
 */
router.post('/embeddings', ah(async (req, res) => {
  const rid = req.id;
  
  logInfo('GW /api/embeddings <- client', { 
    rid, 
    ip: req.ip,
    inputType: Array.isArray(req.body?.input) ? 'batch' : 'single'
  });

  try {
    const body = validate(req.body || {}, {
      input: str().min(1), // Will accept string or we'll handle array below
      model: str().min(1).optional(),
      model_id: num().optional(),
      model_key: str().optional(),
      encoding_format: oneOf(['float', 'base64']).optional(),
      dimensions: num().optional(),
      metadata: obj().optional(),
      conversation_id: str().optional()
    });

    // Handle array input (validation library sees it as string, so check manually)
    const input = req.body.input;
    if (!input || (typeof input !== 'string' && !Array.isArray(input))) {
      return res.status(400).json({ error: 'input must be a string or array of strings' });
    }

    // Get model configuration
    let modelRow;
    if (body.model_id) {
      modelRow = await getModel(body.model_id);
    } else if (body.model_key) {
      modelRow = await getModelByKey(body.model_key);
    }

    // Default to OpenAI if no model configured
    const modelName = body.model || modelRow?.model_name || 'text-embedding-3-small';
    const apiKey = modelRow?.provider_api_key || process.env.OPENAI_API_KEY;
    const baseUrl = modelRow?.provider_base_url || 'https://api.openai.com';

    if (!apiKey) {
      return res.status(400).json({ 
        error: 'No API key configured. Set OPENAI_API_KEY or configure a model with credentials.' 
      });
    }

    // Call embeddings API
    const result = await callOpenAIEmbeddings({
      apiKey,
      baseUrl,
      model: modelName,
      input,
      encoding_format: body.encoding_format,
      dimensions: body.dimensions
    });

    // Calculate cost
    const totalTokens = result.usage?.total_tokens || 0;
    const cost = estimateEmbeddingCost(modelName, totalTokens);

    // Log usage
    await logUsage({
      provider_id: modelRow?.provider_id || null,
      model_id: modelRow?.id || null,
      conversation_id: body.conversation_id || null,
      input_tokens: totalTokens,
      output_tokens: 0,
      prompt_chars: null,
      completion_chars: null,
      cost,
      meta: {
        type: 'embedding',
        input_type: Array.isArray(input) ? 'batch' : 'single',
        input_count: Array.isArray(input) ? input.length : 1,
        encoding_format: body.encoding_format || 'float',
        dimensions: body.dimensions || null,
        ...(body.metadata || {})
      }
    });

    logInfo('GW /api/embeddings success', { 
      rid, 
      tokens: totalTokens, 
      cost,
      vectorCount: result.data?.length || 0
    });

    // Return OpenAI-compatible response
    res.json({
      object: 'list',
      data: result.data,
      model: result.model,
      usage: result.usage
    });

  } catch (err) {
    logError('GW /api/embeddings error', { rid, err: err?.message || String(err) });
    
    const status = err.response?.status || 500;
    res.status(status).json({ 
      error: err.response?.data?.error?.message || err.message || 'Embedding generation failed',
      rid 
    });
  }
}));

/**
 * POST /api/embeddings/batch
 * 
 * Explicit batch endpoint - requires array input
 */
router.post('/embeddings/batch', ah(async (req, res) => {
  const rid = req.id;

  logInfo('GW /api/embeddings/batch <- client', { rid, ip: req.ip });

  // Ensure input is an array
  if (!Array.isArray(req.body?.input)) {
    return res.status(400).json({ 
      error: 'Batch endpoint requires input to be an array of strings',
      rid 
    });
  }

  // Forward to main embeddings endpoint
  return router.handle({ ...req, url: '/embeddings', originalUrl: req.originalUrl }, res);
}));

module.exports = { router };