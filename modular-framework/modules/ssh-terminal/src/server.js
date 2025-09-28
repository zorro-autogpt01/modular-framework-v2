import express from 'express';
import http from 'http';
import morgan from 'morgan';
import { Server as WSServer } from 'ws';
import { Client as SSHClient } from 'ssh2';
import { v4 as uuidv4 } from 'uuid';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined', { skip: (req) => req.path === '/health' }));

const server = http.createServer(app);
const wss = new WSServer({ server, path: '/ssh' });

// In-memory session store
// sessionId -> {
//   id, conn, shell, sftp, wsClients:Set<WebSocket>, createdAt, host, port, username
// }
const sessions = new Map();

function getSessionOrThrow(id) {
  const s = sessions.get(id);
  if (!s) throw new Error('Invalid session');
  return s;
}

function ensureSftp(session) {
  return new Promise((resolve, reject) => {
    if (session.sftp) return resolve(session.sftp);
    session.conn.sftp((err, sftp) => {
      if (err) return reject(err);
      session.sftp = sftp;
      resolve(sftp);
    });
  });
}

function broadcast(session, data) {
  if (!session.wsClients || session.wsClients.size === 0) return;
  for (const ws of session.wsClients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function attachShellListeners(session) {
  if (session._shellAttached) return;
  session._shellAttached = true;
  const shell = session.shell;
  if (!shell) return;
  shell.on('data', (chunk) => {
    try { broadcast(session, Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)); } catch {}
  });
  shell.stderr?.on('data', (chunk) => {
    try { broadcast(session, '[ERR] ' + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))); } catch {}
  });
  shell.on('close', () => {
    // shell ended
    try { broadcast(session, '\n[session] shell closed\n'); } catch {}
  });
}

app.get('/health', (req, res) => {
  res.type('text/plain').send('ssh-terminal-ok\n');
});

app.post('/ssh/connect', async (req, res) => {
  try {
    const { host, port = 22, username, authMethod, password, privateKey, passphrase, remotePath } = req.body || {};
    if (!host || !username) return res.status(400).json({ ok: false, error: 'host and username required' });

    const conn = new SSHClient();
    const sessionId = uuidv4();
    const connectConfig = { host, port, username };
    if (authMethod === 'password' && password) connectConfig.password = password;
    if (authMethod === 'key' && privateKey) connectConfig.privateKey = privateKey;
    if (passphrase) connectConfig.passphrase = passphrase;

    let responded = false;

    conn.on('ready', () => {
      conn.shell({ term: 'xterm-256color', cols: 120, rows: 30 }, (err, stream) => {
        if (err) {
          try { conn.end(); } catch {}
          if (!responded) {
            responded = true;
            return res.status(500).json({ ok: false, error: err.message });
          }
          return;
        }

        const session = {
          id: sessionId,
          conn,
          shell: stream,
          sftp: null,
          wsClients: new Set(),
          createdAt: Date.now(),
          host, port, username,
          remotePath: remotePath || '/'
        };
        sessions.set(sessionId, session);
        attachShellListeners(session);
        if (!responded) {
          responded = true;
          res.json({ ok: true, sessionId });
        }
      });
    });

    conn.on('error', (err) => {
      if (!responded) {
        responded = true;
        res.status(500).json({ ok: false, error: err.message });
      }
      try { conn.end(); } catch {}
      sessions.delete(sessionId);
    });

    conn.on('end', () => {
      const s = sessions.get(sessionId);
      if (s) {
        try { broadcast(s, '\n[session] connection ended\n'); } catch {}
      }
    });

    conn.connect(connectConfig);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/ssh/list', async (req, res) => {
  try {
    const sid = String(req.query.sessionId || '');
    const path = req.query.path ? String(req.query.path) : '.';
    const depth = Math.max(0, Math.min(10, Number(req.query.depth || 1)));
    const session = getSessionOrThrow(sid);
    const sftp = await ensureSftp(session);

    const buildTree = async (p, d) => {
      return new Promise((resolve) => {
        sftp.readdir(p, async (err, list) => {
          if (err) return resolve({ name: p.split('/').filter(Boolean).pop() || p, path: p, type: 'dir', children: [], error: err.message });
          const children = [];
          for (const item of list) {
            const name = item.filename;
            const childPath = (p.endsWith('/') ? p.slice(0, -1) : p) + '/' + name;
            const isDir = item.longname && item.longname.startsWith('d');
            if (isDir && d > 1) {
              const subtree = await buildTree(childPath, d - 1);
              children.push({ name, path: childPath, type: 'dir', children: subtree.children });
            } else {
              children.push({ name, path: childPath, type: isDir ? 'dir' : 'file' });
            }
          }
          resolve({ name: p.split('/').filter(Boolean).pop() || p, path: p, type: 'dir', children });
        });
      });
    };

    const tree = await buildTree(path, depth);
    res.json({ ok: true, tree });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/ssh/read', async (req, res) => {
  try {
    const sid = String(req.query.sessionId || '');
    const path = String(req.query.path || '');
    if (!path) return res.status(400).json({ ok: false, error: 'path required' });
    const session = getSessionOrThrow(sid);
    const sftp = await ensureSftp(session);

    const stream = sftp.createReadStream(path, { encoding: 'utf8' });
    let data = '';
    stream.on('data', (chunk) => { data += chunk; });
    stream.on('error', (err) => res.json({ ok: false, error: err.message }));
    stream.on('close', () => res.json({ ok: true, content: data }));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/ssh/write', async (req, res) => {
  try {
    const { sessionId: sid, path, content } = req.body || {};
    if (!sid || !path || typeof content !== 'string') return res.status(400).json({ ok: false, error: 'sessionId, path, content required' });
    const session = getSessionOrThrow(sid);
    const sftp = await ensureSftp(session);

    const stream = sftp.createWriteStream(path, { encoding: 'utf8' });
    stream.on('error', (err) => res.json({ ok: false, error: err.message }));
    stream.on('close', () => res.json({ ok: true }));
    stream.end(content);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/ssh/mkdir', async (req, res) => {
  try {
    const { sessionId: sid, path, recursive = true } = req.body || {};
    if (!sid || !path) return res.status(400).json({ ok: false, error: 'sessionId and path required' });
    const session = getSessionOrThrow(sid);
    const sftp = await ensureSftp(session);

    const mk = (p) => new Promise((resolve, reject) => sftp.mkdir(p, (err) => err ? reject(err) : resolve()));
    const st = (p) => new Promise((resolve, reject) => sftp.stat(p, (err, stats) => err ? reject(err) : resolve(stats)));

    if (!recursive) {
      await mk(path).catch((e) => { throw e; });
      return res.json({ ok: true });
    }

    const parts = path.split('/').filter(Boolean);
    let current = path.startsWith('/') ? '' : '.';
    for (const part of parts) {
      current = current ? (current + '/' + part) : (path.startsWith('/') ? '/' + part : part);
      try { await st(current); } catch { try { await mk(current); } catch (e) { /* ignore if already exists */ } }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/ssh/disconnect', async (req, res) => {
  try {
    const { sessionId: sid } = req.body || {};
    const session = sessions.get(String(sid));
    if (session) {
      try { session.shell?.end(); } catch {}
      try { session.conn?.end(); } catch {}
      sessions.delete(String(sid));
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const sid = url.searchParams.get('sessionId');
    if (!sid) return ws.close(1008, 'sessionId required');
    const session = sessions.get(sid);
    if (!session) return ws.close(1008, 'invalid session');

    if (!session.wsClients) session.wsClients = new Set();
    session.wsClients.add(ws);
    attachShellListeners(session);

    ws.on('message', (data) => {
      try {
        if (!session.shell?.writable) return;
        if (Buffer.isBuffer(data)) {
          session.shell.write(data);
          return;
        }
        const text = data.toString();
        try {
          const msg = JSON.parse(text);
          if (msg && msg.type === 'data' && typeof msg.data === 'string') {
            session.shell.write(msg.data);
          } else if (msg && msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
            try { session.shell.setWindow(msg.rows, msg.cols, 600, 800); } catch {}
          }
        } catch {
          // treat as raw input
          session.shell.write(text);
        }
      } catch {}
    });

    ws.on('close', () => {
      try { session.wsClients.delete(ws); } catch {}
    });

    ws.send('[session] WebSocket connected\n');
  } catch {
    try { req.socket.destroy(); } catch {}
  }
});

const PORT = Number(process.env.PORT || 3001);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ssh-terminal listening on http://0.0.0.0:${PORT}`);
});
