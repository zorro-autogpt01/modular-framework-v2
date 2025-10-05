const clients = new Set();

function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');
  const client = { res };
  clients.add(client);
  req.on('close', () => clients.delete(client));
}

function emit(type, payload) {
  const data = JSON.stringify({ type, payload, ts: new Date().toISOString() });
  for (const c of clients) {
    try { c.res.write(`data: ${data}\n\n`); } catch { /* ignore */ }
  }
}

module.exports = { sse, emit };
