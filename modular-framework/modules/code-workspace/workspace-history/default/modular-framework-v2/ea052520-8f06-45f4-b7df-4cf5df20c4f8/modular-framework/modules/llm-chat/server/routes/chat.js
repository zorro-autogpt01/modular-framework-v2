const express = require('express');
const router = express.Router();
const { logInfo, logWarn, logError, redact } = require('../logger');
const { extractErrAsync } = require('../util/http');
const { handleOllama } = require('../providers/ollama');
const { handleOpenAICompat } = require('../providers/openaiCompat');

// Attach an id to each request
router.use((req, _res, next) => {
  req.id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`;
  next();
});

// POST /api/chat (and also mounted under /api/llm-chat)
router.post('/chat', async (req, res) => {
  const rid = req.id;
  const {
    provider = 'openai',
    baseUrl,
    apiKey,
    model,
    messages = [],
    temperature,
    max_tokens,
    stream = true,
    useResponses = false,
    reasoning = false
  } = req.body || {};

  const problems = [];
  if (!baseUrl) problems.push('baseUrl is required');
  if (!model) problems.push('model is required');
  if (!Array.isArray(messages)) problems.push('messages must be an array');
  if ((provider === 'openai' || provider === 'openai-compatible') && !apiKey) {
    problems.push('apiKey is required for OpenAI/OpenAI-compatible providers');
  }
  if (problems.length) {
    logWarn('Validation failed', { rid, problems, body: redact(req.body) });
    return res.status(400).json({ error: 'Validation failed', details: problems });
  }

  const sseMode = !!stream;
  if (sseMode) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  }
  const sendSSE = (payload) => {
    if (!sseMode) return;
    try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { try { res.end(); } catch {} }
  };

  const isGpt5 = /^gpt-5/i.test(model) || /^o5/i.test(model);
  const autoResponses = isGpt5 && provider === 'openai';

  logInfo('LLM request', {
    rid, provider, baseUrl, model,
    stream: !!stream,
    useResponses: useResponses || autoResponses,
    reasoning: !!reasoning,
    temperature: (typeof temperature === 'number' ? temperature : null),
    max_tokens: max_tokens ?? null,
  });

  try {
    if (provider === 'ollama') {
      return await handleOllama({ res, sendSSE, rid, baseUrl, model, messages, temperature, sseMode });
    }
    return await handleOpenAICompat({
      res, sendSSE, rid,
      baseUrl, apiKey, model, messages, temperature,
      max_tokens, useResponses: useResponses || autoResponses, reasoning, sseMode
    });
  } catch (err) {
    const message = await extractErrAsync(err);
    logError('LLM fatal error', { rid, message });
    if (sseMode) {
      sendSSE({ type: 'error', message });
      try { res.end(); } catch {}
    } else {
      res.status(500).json({ error: message });
    }
  }
});

module.exports = { router };
