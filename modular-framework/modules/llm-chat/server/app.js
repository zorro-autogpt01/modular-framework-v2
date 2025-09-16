const express = require('express');
const cors = require('cors');
const path = require('path');
const bodyParser = require('body-parser');

const { router: logsRouter } = require('./routes/logs');
const { router: infoRouter } = require('./routes/info');
const { router: healthRouter } = require('./routes/health');
const { router: chatRouter } = require('./routes/chat');

const app = express();

const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/$/, ''); // e.g. "/modules/llm-chat" or ""

// middleware
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));

// static UI
const pub = path.join(__dirname, '..', 'public');

// Serve both at root and at BASE_PATH to support either proxy style
app.use(express.static(pub));
if (BASE_PATH) app.use(BASE_PATH, express.static(pub));

app.get('/', (_req, res) => res.sendFile(path.join(pub, 'index.html')));
if (BASE_PATH) app.get(`${BASE_PATH}/`, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

app.get('/config', (_req, res) => res.sendFile(path.join(pub, 'config.html')));
if (BASE_PATH) app.get(`${BASE_PATH}/config`, (_req, res) => res.sendFile(path.join(pub, 'config.html')));

// basic routes
app.use('/', healthRouter);            // /health (root for Docker healthcheck)
app.use('/api', infoRouter);           // /api/info
app.use('/api', logsRouter);           // /api/logs, /api/logs/clear
if (BASE_PATH) {
  app.use(`${BASE_PATH}/api`, infoRouter);  // /modules/llm-chat/api/info
  app.use(`${BASE_PATH}/api`, logsRouter);  // /modules/llm-chat/api/logs
}

// chat routes (root and prefixed)
app.use('/api', chatRouter); // /api/chat
if (BASE_PATH) app.use(`${BASE_PATH}/api`, chatRouter); // /modules/llm-chat/api/chat

module.exports = app;
