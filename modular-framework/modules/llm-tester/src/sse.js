import { logDebug } from './logger.js';

export function openSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  try { logDebug('LT SSE open'); } catch {}

}
export function send(res, obj) {
  try { logDebug('LT SSE send', { type: obj?.type }); } catch {}

  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
export function close(res) {
  try { logDebug('LT SSE close'); } catch {}

  res.write("event: done\ndata: {}\n\n");
  res.end();
}
