import { v4 as uuidv4 } from 'uuid';
import { connectSSH, resizePty, closeSession } from './sshBridge.js';

const sessions = new Map();

export async function createSession(config) {
  const sessionId = uuidv4();
  const { client, stream } = await connectSSH(config);
  sessions.set(sessionId, { client, stream, ws: null, createdAt: Date.now() });
  // Pipe SSH -> (buffer until WS attaches)
  stream.on('data', (data) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    if (s.ws && s.ws.readyState === 1) s.ws.send(data);
  });
  stream.on('close', () => { cleanup(sessionId); });
  client.on('close', () => { cleanup(sessionId); });
  client.on('error', () => { cleanup(sessionId); });
  return { sessionId };
}

export function attachWebSocket(sessionId, ws) {
  const s = sessions.get(sessionId);
  if (!s) { ws.close(1011, 'Invalid session'); return; }
  s.ws = ws;

  ws.on('message', (msg) => {
    // Accept raw data or JSON messages
    try {
      const text = msg.toString();
      if (text.startsWith('{')) {
        const m = JSON.parse(text);
        if (m.type === 'data' && typeof m.data === 'string') {
          s.stream.write(m.data);
        } else if (m.type === 'resize' && m.cols && m.rows) {
          resizePty(s.stream, m.cols, m.rows);
        }
      } else {
        s.stream.write(text);
      }
    } catch {
      // ignore malformed frames
    }
  });

  ws.on('close', () => {
    // Only drop WS; leave SSH session running until explicit disconnect or remote exit
  });
}

export function disconnect(sessionId) {
  cleanup(sessionId);
}

function cleanup(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  try { closeSession(s.client, s.stream); } catch {}
  try { s.ws?.close(); } catch {}
  sessions.delete(sessionId);
}
