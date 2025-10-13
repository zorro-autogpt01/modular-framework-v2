// Normalizes provider-specific LLM responses to a single structure
// Used by routes/chat.js to produce uniform envelopes.

function normalizeResponse(raw, modelName = null) {
  if (!raw) return { content: '', raw };

  // If already in canonical form (our new envelope)
  if (typeof raw === 'object' && raw.ok && typeof raw.content === 'string') {
    return raw;
  }

  // Try to extract the main text content from any provider format
  let content =
    raw?.content ||
    raw?.message?.content ||
    raw?.choices?.[0]?.message?.content ||
    raw?.choices?.[0]?.delta?.content ||
    '';

  // Anthropic / Responses API formats
  if (!content && Array.isArray(raw.output_text)) {
    content = raw.output_text.join('');
  }

  if (!content && Array.isArray(raw.output)) {
    const parts = [];
    for (const item of raw.output) {
      const arr = item?.content;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          if (typeof p?.text === 'string') parts.push(p.text);
          else if (typeof p?.content === 'string') parts.push(p.content);
        }
      }
    }
    if (parts.length) content = parts.join('');
  }

  // Fallback deep search
  if (!content) {
    const acc = [];
    const walk = (v) => {
      if (!v) return;
      if (typeof v === 'string') acc.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object') {
        if (typeof v.text === 'string') acc.push(v.text);
        if (typeof v.content === 'string') acc.push(v.content);
        for (const k of Object.keys(v)) walk(v[k]);
      }
    };
    walk(raw);
    if (acc.length) content = acc.join(' ');
  }

  return {
    content: content || '',
    model: modelName || null,
    raw
  };
}

module.exports = { normalizeResponse };
