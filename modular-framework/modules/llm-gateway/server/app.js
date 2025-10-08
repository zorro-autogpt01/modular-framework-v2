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
const { router: telemetryRouter } = require('./routes/telemetry');
const { router: conversationsRouter } = require('./routes/conversations');
const { router: templatesRouter } = require('./routes/templates');
const { router: debugRouter } = require('./routes/debug');

const app = express();
const BASE_PATH = (process.env.BASE_PATH || '/llm-gateway').replace(/\/$/, '');

app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));
// Attach request id to each request
app.use(stamp);

// Lightweight http access logging
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

// Log buffer + logging config APIs
app.use('/api', logsRouter);
app.use('/api', loggingRouter);

// Admin API
app.use('/api', adminRouter);        // /api/providers, /api/models

// Chat/gateway API
app.use('/api', chatRouter);         // /api/v1/chat, /api/compat/*

// Usage log API
app.use('/api', usageRouter);        // /api/usage

// Tokenization API
app.use('/api', tokensRouter);       // /api/tokens

// Telemetry (live SSE + snapshots)
app.use('/api', telemetryRouter);    // /api/telemetry/*

// NEW: Conversations
app.use('/api', conversationsRouter); // /api/conversations

// NEW: Templates
app.use('/api', templatesRouter);     // /api/templates

// NEW: Debug/Developer tools
app.use('/api', debugRouter);         // /api/debug/*

// Central error handler (ensures JSON + logs)
app.use((err, req, res, _next) => {
  try { 
    logError('unhandled_error', { 
      rid: req.id,
      message: err?.message || String(err), 
      stack: err?.stack,
      path: req.path
    }); 
  } catch {}
  
  // Send helpful error response
  const status = err.status || 500;
  const response = {
    error: err.message || 'Internal Server Error',
    rid: req.id
  };
  
  // Include validation details if present
  if (err.details) {
    response.details = err.details;
  }
  
  // Include hint for common errors
  if (status === 400) {
    response.hint = 'Check your request body format and required fields';
  } else if (status === 404) {
    response.hint = 'The requested resource was not found';
  } else if (status === 500) {
    response.hint = 'An internal error occurred. Check logs for details';
  }
  
  res.status(status).json(response);
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
  app.use(`${BASE_PATH}/api`, loggingRouter);
  app.use(`${BASE_PATH}/api`, telemetryRouter);
  app.use(`${BASE_PATH}/api`, conversationsRouter);
  app.use(`${BASE_PATH}/api`, templatesRouter);
  app.use(`${BASE_PATH}/api`, debugRouter);

  // Error handler for BASE_PATH-mounted routes as well
  app.use((err, req, res, _next) => {
    try { 
      logError('unhandled_error', { 
        rid: req.id,
        message: err?.message || String(err), 
        stack: err?.stack 
      }); 
    } catch {}
    
    const status = err.status || 500;
    const response = {
      error: err.message || 'Internal Server Error',
      rid: req.id
    };
    
    if (err.details) response.details = err.details;
    
    res.status(status).json(response);
  });

  app.get(`${BASE_PATH}/admin`, (_req, res) => res.sendFile(path.join(pub, 'admin.html')));
}
app.get('/admin', (_req, res) => res.sendFile(path.join(pub, 'admin.html')));

initDb().then(() => console.log('DB ready')).catch(err => {
  console.error('DB init failed', err);
  process.exit(1);
});

module.exports = app;