export function openSSE(res) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
}
export function send(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
export function close(res) {
  res.write("event: done\ndata: {}\n\n");
  res.end();
}
