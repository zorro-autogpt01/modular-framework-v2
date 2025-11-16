// Normalizes both /v1/responses and /v1/chat.completions streams
export function parseStream(onDelta, onDone, onError) {
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
        const t = evt.type || evt.event || '';

        if (t === 'response.output_text.delta') {
          const delta = evt.delta ?? evt.text ?? evt.output_text?.[0]?.content ?? '';
          if (delta) onDelta?.(String(delta));
          continue;
        }
        if (t === 'response.output_text') {
          const textOut = evt.output_text?.join?.('') || evt.text || '';
          if (textOut) onDelta?.(String(textOut));
          continue;
        }
        if (t === 'response.completed') { onDone?.(); continue; }
        if (t === 'error' || evt.error) {
          onError?.(evt.error?.message || evt.message || 'Unknown error from Responses stream');
          continue;
        }

        const delta =
          evt?.choices?.[0]?.delta?.content ??
          evt?.output_text?.[0]?.content ??
          evt?.message?.content ??
          evt?.content;
        if (delta) onDelta?.(String(delta));
      } catch { /* ignore JSON errors */ }
    }
  };
}
