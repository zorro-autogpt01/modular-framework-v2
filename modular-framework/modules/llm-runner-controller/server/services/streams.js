const db = require('./db');
const crypto = require('crypto');

const runClients = new Map(); // runId -> Set(res)

function ensureSet(id) {
  if (!runClients.has(id)) runClients.set(id, new Set());
  return runClients.get(id);
}

function sse(req, res) {
  const { runId } = req.params;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.write('\n');
  const set = ensureSet(runId);
  set.add(res);
  req.on('close', () => {
    try { set.delete(res); } catch {}
  });
}

function send(runId, type, payload) {
  const set = runClients.get(runId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify({ type, payload, ts: new Date().toISOString(), runId });
  for (const res of set) {
    try { res.write(`data: ${data}\n\n`); } catch { /* ignore */ }
  }
}

function nextSeq(runId) {
  const r = db.one('SELECT COALESCE(MAX(seq), 0) AS m FROM run_logs WHERE run_id = ?', [runId]);
  return Number(r?.m || 0) + 1;
}

function appendLog(runId, stream, chunk) {
  const seq = nextSeq(runId);
  db.run('INSERT INTO run_logs (run_id, seq, stream, chunk) VALUES (?,?,?,?)', [runId, seq, stream, String(chunk || '')]);
  send(runId, 'run.output', { stream, data: String(chunk || '') });
}

function finished(runId, summary) {
  send(runId, 'run.finished', summary || {});
}

function uuid() { return crypto.randomUUID(); }

module.exports = { sse, send, appendLog, finished, uuid };
