// modular-framework/modules/llm-chat/public/js/sse.js

// Normalizes both /v1/responses and /v1/chat.completions streams
// and also supports simple {type:"delta"} / {type:"done"} protocol.
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

      // OpenAI-style sentinel
      if (payload === '[DONE]') { onDone?.(); continue; }

      try {
        const evt = JSON.parse(payload);
        const t = evt.type || evt.event || '';

        // Simple gateway protocol
        if (t === 'done') { onDone?.(); continue; }
        if (t === 'delta' && (evt.content ?? '') !== '') {
          onDelta?.(String(evt.content)); continue;
        }

        // OpenAI Responses API variants
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

        // Error event
        if (t === 'error' || evt.error) {
          onError?.(evt.error?.message || evt.message || 'Unknown error from Responses stream');
          continue;
        }

        // Fallbacks (chat.completions, or generic JSON payloads)
        const delta =
          evt?.choices?.[0]?.delta?.content ??
          evt?.output_text?.[0]?.content ??
          evt?.message?.content ??
          evt?.content;
        if (delta) onDelta?.(String(delta));
      } catch {
        // ignore JSON parse errors for non-JSON "data:" lines
      }
    }
  };
}
