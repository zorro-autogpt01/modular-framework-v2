// server/routes/telemetry.js
const express = require('express');
const router = express.Router();
const { listRecent, listLive, attachSSE } = require('../telemetry/interactions');

router.get('/telemetry/recent', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit || 20), 200));
  res.json({ items: listRecent(limit) });
});

router.get('/telemetry/ongoing', (_req, res) => {
  res.json({ items: listLive() });
});

router.get('/telemetry/live', (req, res) => {
  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Initial snapshot
  const snapshot = { type: 'snapshot', live: listLive(), recent: listRecent(20) };
  res.write(`data: ${JSON.stringify(snapshot)}\n\n`);

  // Subscribe to bus
  const unsubscribe = attachSSE(res);

  // Keep-alive heartbeat
  const hb = setInterval(() => {
    try { res.write(':\n\n'); } catch (_) {}
  }, 20000);

  // Cleanup
  const end = () => { clearInterval(hb); unsubscribe(); try { res.end(); } catch (_) {} };
  req.on('close', end);
  req.on('aborted', end);
});

module.exports = { router };
