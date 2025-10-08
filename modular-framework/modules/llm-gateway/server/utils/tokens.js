const { get_encoding } = require('@dqbd/tiktoken');

/**
 * Pick a default encoding based on model name (best-effort).
 * - o* / gpt-5* → o200k_base
 * - default → cl100k_base
 */
function pickEncodingForModel(modelName = '') {
  const m = String(modelName).toLowerCase();
  if (/^(gpt-5|o\d)/.test(m)) return 'o200k_base';
  return 'cl100k_base';
}

/** Count tokens for plain text with a given encoding name. */
function countTextTokens(text = '', encodingName = 'cl100k_base') {
  if (!text) return 0;
  const enc = get_encoding(encodingName);
  try {
    const tokens = enc.encode(text || '');
    return tokens.length;
  } finally {
    enc.free();
  }
}

/**
 * Approximate chat token counting for messages[].
 * We encode role/name/content and add a small overhead per message,
 * following OpenAI ChatML guidelines (still approximate).
 */
function countChatTokens(messages = [], encodingName = 'cl100k_base') {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  // heuristic overheads (best-effort)
  const OVERHEAD = {
    cl100k_base: { perMessage: 4, perName: -1, priming: 2 },
    o200k_base:  { perMessage: 3, perName:  1, priming: 2 },
  };
  const ov = OVERHEAD[encodingName] || OVERHEAD.cl100k_base;

  const enc = get_encoding(encodingName);
  try {
    let total = ov.priming || 0;
    for (const m of messages) {
      total += ov.perMessage || 0;
      if (m.role) total += enc.encode(String(m.role)).length;
      if (m.name) total += (ov.perName || 0) + enc.encode(String(m.name)).length;
      // content can be string or array of parts (text/images); we count only text parts
      const c = m.content;
      if (typeof c === 'string') {
        total += enc.encode(c).length;
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (typeof part?.text === 'string') total += enc.encode(part.text).length;
        }
      }
    }
    return total;
  } finally {
    enc.free();
  }
}

module.exports = {
  pickEncodingForModel,
  countTextTokens,
  countChatTokens,
};
