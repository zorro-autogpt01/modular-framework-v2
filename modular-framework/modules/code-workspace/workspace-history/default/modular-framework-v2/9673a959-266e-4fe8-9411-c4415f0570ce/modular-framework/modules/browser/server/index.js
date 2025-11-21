const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3008;
const { WebSocketServer } = require('ws');

const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const httpProxy = require('http-proxy');
const server = http.createServer(app);

const { v4: uuidv4 } = require('uuid');
const puppeteer = require('puppeteer-core');
const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const wss = new WebSocketServer({ noServer: true });

const CHROME_BIN_CANDIDATES = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'];
// id -> WebSocket
const uiClients = new Map();

const CONTROL_TOKEN = process.env.BROWSER_CONTROL_TOKEN || '';
//function authOk(req) {
//  if (!CONTROL_TOKEN) return true; // no auth in dev
//  const h = req.headers['authorization'] || '';
//  return h === `Bearer ${CONTROL_TOKEN}`;
//}

function authOk(_req) { return true; } // DEV-ONLY





function findChrome() {
  for (const p of CHROME_BIN_CANDIDATES) if (fs.existsSync(p)) return p;
  return process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser';
}

const sessions = new Map(); // id -> { browser, page, debugPort, targetId, eventBus, headers }

async function launchSession(opts = {}) {
  const execPath = findChrome();
  const browser = await puppeteer.launch({
    executablePath: execPath,
    headless: true,           // change to false if you ever want a visible X display
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--remote-debugging-port=0', // let Chrome pick a free port; we’ll discover it
      '--no-first-run', '--no-default-browser-check'
    ]
  });

  // Discover the devtools port from wsEndpoint (ws://127.0.0.1:PORT/devtools/…)
  const m = browser.wsEndpoint().match(/:(\d+)\//);
  const debugPort = m ? Number(m[1]) : 0;

  const page = await browser.newPage();
  if (opts.viewport) await page.setViewport(opts.viewport);
  if (opts.headers)  await page.setExtraHTTPHeaders(opts.headers);

  // Basic console/network event stream for SSE
  const events = [];
  const push = (type, payload) => {
    const ev = { id: Date.now() + Math.random(), t: new Date().toISOString(), type, payload };
    events.push(ev); while (events.length > 500) events.shift();
  };
  page.on('console', msg => push('console', { type: msg.type(), text: msg.text() }));
  page.on('request', r => push('request', { url: r.url(), method: r.method() }));
  page.on('response', r => push('response', { url: r.url(), status: r.status() }));

  const id = uuidv4();
  const target = page.target(); // Keep for devtools target id
  const targetId = target._targetId || ''; // puppeteer private, but works

  sessions.set(id, { browser, page, debugPort, targetId, headers: opts.headers || {}, events });
  return { id, debugPort, targetId };
}


function isPrivateIP(ip) {
  const b = ip.split('.').map(Number);
  return (
    b[0] === 10 ||
    (b[0] === 172 && b[1] >= 16 && b[1] <= 31) ||
    (b[0] === 192 && b[1] === 168) ||
    ip === '127.0.0.1' ||
    ip === '0.0.0.0'
  );
}

app.get('/api/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'URL parameter required' });

  let u;
  try {
    u = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!['http:', 'https:'].includes(u.protocol)) {
    return res.status(400).json({ error: 'Protocol not allowed' });
  }

  try {
    // Resolve and block private IPs (basic SSRF protection)
    const addrs = await dns.lookup(u.hostname, { all: true, family: 4 });
    if (addrs.some(a => isPrivateIP(a.address))) {
      return res.status(403).json({ error: 'Target not allowed' });
    }

    const upstream = await axios.get(u.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 ModularFrameworkBrowser/1.0' },
      responseType: 'arraybuffer',          // handle any content
      maxContentLength: 50 * 1024 * 1024,   // 50MB
      maxBodyLength: 50 * 1024 * 1024,
      validateStatus: () => true
    });

    // Pass through non-HTML as-is
    const contentType = upstream.headers['content-type'] || 'application/octet-stream';
    if (!/^text\/html/i.test(contentType)) {
      res.status(upstream.status);
      Object.entries(upstream.headers).forEach(([k, v]) => {
        if (!/^content-security-policy/i.test(k)) res.setHeader(k, v);
      });
      return res.send(Buffer.from(upstream.data));
    }

    // HTML: inject <base> to repair relative URLs
    const html = Buffer.from(upstream.data).toString('utf8');
    const base = `${u.protocol}//${u.host}`;
    const patched = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}/">`);

    res.status(upstream.status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Loosen frame-ancestors so it renders inside your pane
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    return res.send(patched);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));


// Screenshot endpoint using Puppeteer (optional)
app.get('/api/screenshot', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const browser = await puppeteer.launch({
      executablePath: findChrome(),
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
    });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle2' });
    const screenshot = await page.screenshot({ type: 'png' });
    await browser.close();
    res.setHeader('Content-Type', 'image/png');
    res.send(screenshot);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Bookmarks API
const bookmarks = [];

app.get('/api/bookmarks', (req, res) => {
    res.json(bookmarks);
});

app.post('/api/bookmarks', (req, res) => {
    const { title, url } = req.body;
    const bookmark = { id: Date.now(), title, url, created: new Date() };
    bookmarks.push(bookmark);
    res.json(bookmark);
});

app.delete('/api/bookmarks/:id', (req, res) => {
    const index = bookmarks.findIndex(b => b.id === parseInt(req.params.id));
    if (index > -1) {
        bookmarks.splice(index, 1);
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Bookmark not found' });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/api/ui/ws')) return socket.destroy();
  if (!authOk(req)) return socket.destroy();

  const qs = new URL(req.url, 'http://x').searchParams;
  const id = qs.get('id');
  if (!id) return socket.destroy();

  wss.handleUpgrade(req, socket, head, (ws) => {
    uiClients.set(id, ws);
    ws.on('close', () => uiClients.delete(id));
  });
});

// helper to push a command to a given client
function sendCmd(id, cmd) {
  const ws = uiClients.get(id);
  if (!ws || ws.readyState !== ws.OPEN) throw new Error('UI not connected');
  ws.send(JSON.stringify(cmd));
}

server.listen(PORT, () => {
  console.log(`Browser module running on port ${PORT}`);
});

app.post('/api/sessions', async (req, res) => {
  try {
    const { viewport, headers } = req.body || {};
    const s = await launchSession({ viewport, headers });
    res.json({ sessionId: s.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Close session
app.delete('/api/sessions/:id', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  await s.browser.close();
  sessions.delete(req.params.id);
  res.json({ ok: true });
});

// Navigate
app.post('/api/sessions/:id/navigate', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { url, waitUntil = 'networkidle2', timeout = 45000 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  await s.page.goto(url, { waitUntil, timeout });
  res.json({ ok: true });
});

// History ops
app.post('/api/sessions/:id/reload', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  await s.page.reload({ waitUntil: 'networkidle2' });
  res.json({ ok: true });
});
app.post('/api/sessions/:id/back', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  await s.page.goBack({ waitUntil: 'networkidle2' }); res.json({ ok: true });
});
app.post('/api/sessions/:id/forward', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  await s.page.goForward({ waitUntil: 'networkidle2' }); res.json({ ok: true });
});

// Interactions
app.post('/api/sessions/:id/click', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { selector, timeout = 15000 } = req.body || {};
  if (!selector) return res.status(400).json({ error: 'selector required' });
  await s.page.waitForSelector(selector, { timeout });
  await s.page.click(selector);
  res.json({ ok: true });
});
app.post('/api/sessions/:id/type', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { selector, text, delay = 0, timeout = 15000 } = req.body || {};
  if (!selector || text == null) return res.status(400).json({ error: 'selector & text required' });
  await s.page.waitForSelector(selector, { timeout });
  await s.page.type(selector, text, { delay });
  res.json({ ok: true });
});
app.post('/api/sessions/:id/waitFor', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { selector, timeout = 30000 } = req.body || {};
  await s.page.waitForSelector(selector, { timeout });
  res.json({ ok: true });
});

// Evaluate JS
app.post('/api/sessions/:id/eval', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const { script } = req.body || {};
  if (!script) return res.status(400).json({ error: 'script required' });
  const result = await s.page.evaluate(new Function(`return (${script});`));
  res.json({ result });
});

// Screenshot / PDF
app.post('/api/sessions/:id/screenshot', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const { fullPage = true, type = 'png' } = req.body || {};
  const buf = await s.page.screenshot({ fullPage, type });
  res.setHeader('Content-Type', type === 'jpeg' ? 'image/jpeg' : 'image/png');
  res.send(buf);
});
app.post('/api/sessions/:id/pdf', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const { format = 'A4', printBackground = true } = req.body || {};
  const pdf = await s.page.pdf({ format, printBackground });
  res.setHeader('Content-Type', 'application/pdf');
  res.send(pdf);
});

// Headers / cookies / viewport
app.post('/api/sessions/:id/headers', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  s.headers = req.body || {};
  await s.page.setExtraHTTPHeaders(s.headers);
  res.json({ ok: true });
});
app.post('/api/sessions/:id/viewport', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  await s.page.setViewport(req.body || { width: 1280, height: 800, deviceScaleFactor: 1 });
  res.json({ ok: true });
});
app.post('/api/sessions/:id/cookies', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  const { cookies = [] } = req.body || {};
  await s.page.setCookie(...cookies);
  res.json({ ok: true });
});
// REST endpoints to drive the visible pane
app.post('/api/ui/:id/navigate', (req, res) => {
  if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' });
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  try { sendCmd(req.params.id, { type: 'navigate', url }); res.json({ ok: true }); }
  catch (e) { res.status(409).json({ error: e.message }); }
});

app.post('/api/ui/:id/reload',  (req, res) => { if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' }); try { sendCmd(req.params.id, { type: 'reload'  }); res.json({ ok: true }); } catch (e) { res.status(409).json({ error: e.message }); } });
app.post('/api/ui/:id/back',    (req, res) => { if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' }); try { sendCmd(req.params.id, { type: 'back'    }); res.json({ ok: true }); } catch (e) { res.status(409).json({ error: e.message }); } });
app.post('/api/ui/:id/forward', (req, res) => { if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' }); try { sendCmd(req.params.id, { type: 'forward' }); res.json({ ok: true }); } catch (e) { res.status(409).json({ error: e.message }); } });
app.post('/api/ui/:id/proxy',   (req, res) => { if (!authOk(req)) return res.status(401).json({ error: 'unauthorized' }); try { sendCmd(req.params.id, { type: 'proxy', enable: !!req.body?.enable }); res.json({ ok: true }); } catch (e) { res.status(409).json({ error: e.message }); } });


app.get('/api/sessions/:id/cookies', async (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).json({ error: 'not found' });
  res.json(await s.page.cookies());
});

// Event stream (console/network)
app.get('/api/sessions/:id/events', (req, res) => {
  const s = sessions.get(req.params.id); if (!s) return res.status(404).end();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let last = 0;
  const timer = setInterval(() => {
    while (last < s.events.length) {
      const ev = s.events[last++];
      res.write(`id: ${ev.id}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  }, 1000);
  req.on('close', () => clearInterval(timer));
});

// DevTools proxy (HTTP + WS) for this session’s Chrome
app.use('/api/devtools/:id', (req, res, next) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).send('session not found');
  return createProxyMiddleware({
    target: `http://127.0.0.1:${s.debugPort}`,
    changeOrigin: true,
    ws: true,
    secure: false,
    pathRewrite: { [`^/api/devtools/${req.params.id}`]: '' }
  })(req, res, next);
});

// Helper to get an embeddable DevTools URL for the current page
app.get('/api/sessions/:id/devtools', async (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });

  try {
    const list = await axios.get(`http://127.0.0.1:${s.debugPort}/json`);
    const pageEntry = list.data.find(x => x.type === 'page' && x.url);
    const targetId = pageEntry?.id || s.targetId;

    const tail = `/api/sessions/${req.params.id}/devtools`;
    const prefix = req.originalUrl.endsWith(tail)
      ? req.originalUrl.slice(0, -tail.length)
      : ''; // e.g. '/api/browser'

    const base = `${prefix}/api/devtools/${req.params.id}`;
    const devtoolsUrl =
      `${base}/devtools/inspector.html?ws=${req.headers.host}${base}/devtools/page/${targetId}`;

    res.json({ devtoolsUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});