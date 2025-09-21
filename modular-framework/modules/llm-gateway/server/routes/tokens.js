const express = require('express');
const router = express.Router();
const { pickEncodingForModel, countTextTokens, countChatTokens } = require('../utils/tokens');

/**
 * POST /api/tokens
 * Body:
 * {
 *   model?: string,            // e.g. "gpt-4o-mini" or "gpt-5"
 *   encoding?: string,         // override, e.g. "o200k_base" | "cl100k_base"
 *   text?: string,             // raw text to count
 *   messages?: [ { role, content, name? } ]  // chat-style messages
 * }
 *
 * Response: { model, encoding, text_tokens, message_tokens, total_tokens, note }
 */
router.post('/tokens', async (req, res) => {
  try {
    const { model, encoding, text, messages } = req.body || {};
    const encodingName = encoding || pickEncodingForModel(model);

    const textTokens = (typeof text === 'string')
      ? countTextTokens(text, encodingName)
      : null;

    const messageTokens = Array.isArray(messages)
      ? countChatTokens(messages, encodingName)
      : null;

    const total = [textTokens, messageTokens]
      .filter(v => typeof v === 'number')
      .reduce((a, b) => a + b, 0);

    res.json({
      model: model || null,
      encoding: encodingName,
      text_tokens: textTokens,
      message_tokens: messageTokens,
      total_tokens: total || 0,
      note: 'Token counts computed with @dqbd/tiktoken. Chat overhead is an approximation.',
    });
  } catch (e) {
    res.status(400).json({ error: e.message || 'tokenization error' });
  }
});

module.exports = { router };
