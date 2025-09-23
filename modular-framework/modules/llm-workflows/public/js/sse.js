export function parseStream(onDelta, onEvent, onDone, onError) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.replace(/^data:\s*/, '').trim();
      if (!payload) continue;
      if (payload === '[DONE]') { onDone?.(); continue; }
      try {
        const evt = JSON.parse(payload);

        // Accept both "llm.delta" (older) and "delta" (normalized) event types
        if ((evt.type === 'llm.delta' || evt.type === 'delta') && typeof evt.data === 'string') {
          onDelta?.(evt.data);
          continue;
        }
        if (evt.type === 'delta' && typeof evt.content === 'string') {
          onDelta?.(evt.content);
          continue;
        }

        if (evt.type === 'error') {
          onError?.(evt.message || 'error');
          continue;
        }
        if (evt.type === 'done') {
          onDone?.();
          continue;
        }

        // Fallback generic content shapes
        const content =
          evt?.choices?.[0]?.delta?.content ??
          evt?.output_text?.[0]?.content ??
          evt?.message?.content ??
          evt?.content;
        if (content) {
          onDelta?.(String(content));
        } else {
          onEvent?.(evt);
        }
      } catch {
        // fallback: if chunk is plain delta text
        onDelta?.(payload);
      }
    }
  };
}