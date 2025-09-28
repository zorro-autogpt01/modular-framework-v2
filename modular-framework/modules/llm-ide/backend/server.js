import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createSession, attachWebSocket, disconnect, listRemote, readRemote, writeRemote, mkdirRemote } from './sshManager.js';

const PORT = process.env.PORT || 3021;
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));

// --- HTTP API ---
app.post('/ssh/connect', async (req, res) => {
  try {
    const { host, port = 22, username, authMethod } = req.body || {};
    if (!host || !username || !authMethod) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    console.log('[api] /ssh/connect', { host, port, username, authMethod }); // no secrets
    const { sessionId } = await createSession(req.body);
    return res.json({ ok: true, sessionId });
  } catch (err) {
    console.error('[api] connect failed', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'Connect failed' });
  }
});

app.get('/ssh/list', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const path = req.query.path;
    console.log('[api] /ssh/read', { sessionId, path });

    const depth = Math.max(0, Math.min(5, parseInt(req.query.depth || '2', 10)));
    console.log('[api] /ssh/list', { sessionId, path, depth });

    if (!sessionId || !path) return res.status(400).json({ ok: false, error: 'Missing sessionId or path' });
    const tree = await listRemote(sessionId, path, depth);
    return res.json({ ok: true, tree });
  } catch (err) {
    console.error('[api] list failed', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'List failed' });
  }
});

app.get('/ssh/read', async (req, res) => {
  try {
    const sessionId = req.query.sessionId;
    const path = req.query.path;
    if (!sessionId || !path) return res.status(400).json({ ok: false, error: 'Missing sessionId or path' });
    const content = await readRemote(sessionId, path);
    return res.json({ ok: true, content });
  } catch (err) {
    console.error('[api] read failed', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'Read failed' });
  }
});


app.post('/ssh/write', async (req, res) => {
  try {
    const { sessionId, path, content } = req.body || {};
    if (!sessionId || !path) return res.status(400).json({ ok: false, error: 'Missing sessionId or path' });
    await writeRemote(sessionId, path, content ?? '');
    return res.json({ ok: true });
  } catch (err) {
    console.error('[api] write failed', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'Write failed' });
  }
});

app.post('/ssh/mkdir', async (req, res) => {
  try {
    const { sessionId, path, recursive = true } = req.body || {};
    if (!sessionId || !path) return res.status(400).json({ ok: false, error: 'Missing sessionId or path' });
    await mkdirRemote(sessionId, path, { recursive: !!recursive });
    return res.json({ ok: true });
  } catch (err) {
    console.error('[api] mkdir failed', err?.message || err);
    return res.status(500).json({ ok: false, error: err?.message || 'Mkdir failed' });
  }
});

app.post('/ssh/disconnect', (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing sessionId' });
  disconnect(sessionId);
  return res.json({ ok: true });
});

// --- HTTP -> WS server ---
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ssh') { socket.destroy(); return; }
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) { socket.destroy(); return; }
  wss.handleUpgrade(request, socket, head, (ws) => {
    attachWebSocket(sessionId, ws);
  });
});

server.listen(PORT, () => console.log(`[SSH-Bridge] Listening on ${PORT}`));
