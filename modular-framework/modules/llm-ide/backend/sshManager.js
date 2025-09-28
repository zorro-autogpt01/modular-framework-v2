import { v4 as uuidv4 } from 'uuid';
import { connectSSH, resizePty, closeSession, listTree, readFileContent, writeFileContent, makeDirectory } from './sshBridge.js';

const sessions = new Map();
const listCache = new Map();
const CACHE_TTL_MS = 30000;
function cacheKey(sessionId, path, depth){ return `${sessionId}|${path}|${depth}`; }
function invalidateListCache(sessionId, changedPath = null) {
  for (const key of Array.from(listCache.keys())) {
    if (key.startsWith(sessionId + '|')) {
      if (!changedPath) { listCache.delete(key); continue; }
      const parts = key.split('|');
      const p = parts[1] || '';
      if (p === changedPath || p.startsWith(changedPath) || changedPath.startsWith(p)) {
        listCache.delete(key);
      }
    }
  }
}


export async function createSession(config) {
  const sessionId = uuidv4();
  console.log('[mgr] creating session', sessionId, { host: config.host, user: config.username, auth: config.authMethod });
  const { client, stream } = await connectSSH(config);
  sessions.set(sessionId, { client, stream, ws: null, createdAt: Date.now() });

  stream.on('data', (data) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    if (s.ws && s.ws.readyState === 1) s.ws.send(data);
  });
  stream.on('close', () => { console.log('[mgr] stream close', sessionId); cleanup(sessionId); });
  client.on('close', () => { console.log('[mgr] client close', sessionId); cleanup(sessionId); });
  client.on('error', (e) => { console.log('[mgr] client error', sessionId, e?.message); cleanup(sessionId); });

  return { sessionId };
}

export function attachWebSocket(sessionId, ws) {
  const s = sessions.get(sessionId);
  if (!s) { ws.close(1011, 'Invalid session'); return; }
  console.log('[mgr] WS attached', sessionId);
  s.ws = ws;

  ws.on('message', (msg) => {
    try {
      const text = msg.toString();
      if (text.startsWith('{')) {
        const m = JSON.parse(text);
        if (m.type === 'data' && typeof m.data === 'string') s.stream.write(m.data);
        else if (m.type === 'resize' && m.cols && m.rows) resizePty(s.stream, m.cols, m.rows);
      } else {
        s.stream.write(text);
      }
    } catch (e) {
      console.log('[mgr] bad WS frame', e?.message);
    }
  });

  ws.on('close', () => console.log('[mgr] WS closed', sessionId));
}

function cleanup(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  console.log('[mgr] cleanup', sessionId);
  try { closeSession(s.client, s.stream); } catch {}
  try { s.ws?.close(); } catch {}
  sessions.delete(sessionId);
}

export async function listRemote(sessionId, path, depth = 2) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid session');
  const key = cacheKey(sessionId, path, depth);
  const now = Date.now();
  const cached = listCache.get(key);
  if (cached && (now - cached.ts) < CACHE_TTL_MS) return cached.data;
  const data = await listTree(s.client, path, depth);
  listCache.set(key, { ts: now, data });
  return data;
}

export async function readRemote(sessionId, path) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid session');
  return await readFileContent(s.client, path);
}



export async function writeRemote(sessionId, path, content) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid session');
  return await writeFileContent(s.client, path, content);
  // Invalidate directory listing cache for this session
  try { invalidateListCache(sessionId, path); } catch {}

}

export async function mkdirRemote(sessionId, path, options) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('Invalid session');
  return await makeDirectory(s.client, path, options);
  // Invalidate directory listing cache for this session
  try { invalidateListCache(sessionId, path); } catch {}

}

export function disconnect(sessionId) {
  cleanup(sessionId);
}

