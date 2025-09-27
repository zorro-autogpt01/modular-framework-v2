import express from 'express';
import http from 'http';
import cors from 'cors';
import { WebSocketServer } from 'ws';
import { createSession, attachWebSocket, disconnect } from './sshManager.js';

const PORT = process.env.PORT || 3021;
const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '256kb' }));

// --- HTTP API ---
app.post('/ssh/connect', async (req, res) => {
  try {
    const { host, port = 22, username, authMethod, password, privateKey, passphrase } = req.body || {};
    if (!host || !username || !authMethod) return res.status(400).json({ ok: false, error: 'Missing required fields' });

    // Never log secrets
    const { sessionId } = await createSession({ host, port, username, authMethod, password, privateKey, passphrase });
    return res.json({ ok: true, sessionId });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || 'Connect failed' });
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
