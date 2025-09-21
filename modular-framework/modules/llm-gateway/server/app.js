const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

const { initDb } = require('./db');
const { router: healthRouter } = require('./routes/health');
const { router: infoRouter } = require('./routes/info');
const { router: adminRouter } = require('./routes/admin');
const { router: chatRouter } = require('./routes/chat');
const { router: usageRouter } = require('./routes/usage');

const app = express();
const BASE_PATH = (process.env.BASE_PATH || '/llm-gateway').replace(/\/$/, '');

app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));

// Static admin UI
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub));

// Health & info
app.use('/', healthRouter);          // /health
app.use('/api', infoRouter);         // /api/info

// Admin API
app.use('/api', adminRouter);        // /api/providers, /api/models

// Chat/gateway API
app.use('/api', chatRouter);         // /api/v1/chat, /api/compat/llm-chat

// Usage log API
app.use('/api', usageRouter);        // /api/usage

// Also serve under BASE_PATH (reverse proxy friendly)
if (BASE_PATH) {
  app.use(BASE_PATH, express.static(pub));
  app.use(`${BASE_PATH}/api`, healthRouter);
  app.use(`${BASE_PATH}/api`, infoRouter);
  app.use(`${BASE_PATH}/api`, adminRouter);
  app.use(`${BASE_PATH}/api`, chatRouter);
  app.use(`${BASE_PATH}/api`, usageRouter);

  app.get(`${BASE_PATH}/admin`, (_req, res) => res.sendFile(path.join(pub, 'admin.html')));
}
app.get('/admin', (_req, res) => res.sendFile(path.join(pub, 'admin.html')));

initDb().then(() => console.log('DB ready')).catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

module.exports = app;

