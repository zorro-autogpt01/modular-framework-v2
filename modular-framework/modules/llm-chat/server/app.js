const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

const { router: logsRouter } = require('./routes/logs');
const { router: infoRouter } = require('./routes/info');
const { router: healthRouter } = require('./routes/health');
const { router: chatRouter } = require('./routes/chat');
const { router: workflowsRouter } = require('./routes/workflows');
const { router: agentRouter } = require('./routes/agent');const { router: loggingRouter } = require('./routes/logging');

const { stamp, logInfo } = require('./logger');

const app = express();

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, ''); // e.g. "/modules/llm-chat" or ""

// middleware
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));
app.use(stamp);

// lightweight HTTP access logging (to Splunk)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    logInfo('http_access', {
      rid: req.id,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      duration_ms: Math.round(durMs),
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
      ua: req.headers['user-agent'] || ''
    });
  });
  next();
});

// static UI
const pub = path.join(__dirname, '..', 'public');

// Serve both at root and at BASE_PATH to support either proxy style
app.use(express.static(pub));
if (BASE_PATH) app.use(BASE_PATH, express.static(pub));

app.get('/', (_req, res) => res.sendFile(path.join(pub, 'index.html')));
if (BASE_PATH) app.get(`${BASE_PATH}/`, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

app.get('/config', (_req, res) => res.sendFile(path.join(pub, 'config.html')));
if (BASE_PATH) app.get(`${BASE_PATH}/config`, (_req, res) => res.sendFile(path.join(pub, 'config.html')));

// basic routes// admin logging API (for logging orchestrator)
app.use('/admin-api', loggingRouter);
if (BASE_PATH) app.use(`${BASE_PATH}/admin-api`, loggingRouter);


app.use('/', healthRouter);            // /health (root for Docker healthcheck)
app.use('/api', infoRouter);           // /api/info
app.use('/api', logsRouter);           // /api/logs, /api/logs/clear
app.use('/api', workflowsRouter);
app.use('/api', agentRouter);
if (BASE_PATH) {
  app.use(`${BASE_PATH}/api`, workflowsRouter);
  app.use(`${BASE_PATH}/api`, agentRouter);
}
if (BASE_PATH) {
  app.use(`${BASE_PATH}/api`, infoRouter);  // /modules/llm-chat/api/info
  app.use(`${BASE_PATH}/api`, logsRouter);  // /modules/llm-chat/api/logs
}

// chat routes (root and prefixed)
app.use('/api', chatRouter); // /api/chat
if (BASE_PATH) app.use(`${BASE_PATH}/api`, chatRouter); // /modules/llm-chat/api/chat

// central error handler (ensures errors are logged and returned as JSON)
app.use((err, _req, res, _next) => {
  try {
    const { logError } = require('./logger');
    logError('unhandled_error', { message: err?.message || String(err), stack: err?.stack });
  } catch {}
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;
