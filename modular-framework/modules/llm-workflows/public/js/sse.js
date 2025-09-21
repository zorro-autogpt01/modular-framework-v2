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
        if (evt.type === 'llm.delta' && typeof evt.data === 'string') {
          onDelta?.(evt.data);
        } else if (evt.type === 'error') {
          onError?.(evt.message || 'error');
        } else if (evt.type === 'done') {
          onDone?.();
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

