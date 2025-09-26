const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

const { initDb } = require('./db');
const { router: logsRouter } = require('./routes/logs');
const { stamp, logInfo, logError } = require('./logger');
const { router: healthRouter } = require('./routes/health');
const { router: infoRouter } = require('./routes/info');
const { router: adminRouter } = require('./routes/admin');
const { router: chatRouter } = require('./routes/chat');
const { router: usageRouter } = require('./routes/usage');
const { router: tokensRouter } = require('./routes/tokens');
const { router: loggingRouter } = require('./routes/logging');

const app = express();
const BASE_PATH = (process.env.BASE_PATH || '/llm-gateway').replace(/\/$/, '');

app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));
// Attach request id to each request
app.use(stamp);

// Lightweight http access logging for Splunk
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


// Static admin UI
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));

// Health & info
app.use('/', healthRouter);          // /health
app.use('/api', infoRouter);         // /api/info

// Admin API// Log buffer API
app.use('/api', logsRouter);
app.use('/api', loggingRouter);

// Admin API

app.use('/api', adminRouter);        // /api/providers, /api/models

// Chat/gateway API
app.use('/api', chatRouter);         // /api/v1/chat, /api/compat/llm-chat

// Usage log API
app.use('/api', usageRouter);        // /api/usage
// Tokenization API
app.use('/api', tokensRouter);       // /api/tokens
// Central error handler (ensures JSON + logs)
app.use((err, _req, res, _next) => {
  try { logError('unhandled_error', { message: err?.message || String(err), stack: err?.stack }); } catch {}
  res.status(500).json({ error: 'Internal Server Error' });
});


// Also serve under BASE_PATH (reverse proxy friendly)
if (BASE_PATH) {
  app.use(BASE_PATH, express.static(pub));
  app.use(`${BASE_PATH}/api`, healthRouter);
  app.use(`${BASE_PATH}/api`, infoRouter);
  app.use(`${BASE_PATH}/api`, adminRouter);
  app.use(`${BASE_PATH}/api`, chatRouter);
  app.use(`${BASE_PATH}/api`, usageRouter);
  app.use(`${BASE_PATH}/api`, tokensRouter);
  app.use(`${BASE_PATH}/api`, logsRouter);

  // Error handler for BASE_PATH-mounted routes as well
  app.use((err, _req, res, _next) => {
    try { logError('unhandled_error', { message: err?.message || String(err), stack: err?.stack }); } catch {}
    res.status(500).json({ error: 'Internal Server Error' });
  });


  app.get(`${BASE_PATH}/admin`, (_req, res) => res.sendFile(path.join(pub, 'admin.html')));
}
app.get('/admin', (_req, res) => res.sendFile(path.join(pub, 'admin.html')));

initDb().then(() => console.log('DB ready')).catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

module.exports = app;

