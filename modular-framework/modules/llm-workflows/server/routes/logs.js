const express = require('express');
const router = express.Router();
const { logs } = require('../logger');

router.get('/logs', (req, res) => {
  const limit = Math.max(1, Math.min(Number(req.query.limit || 200), 2000));
  const start = Math.max(0, logs.length - limit);
  res.json(logs.slice(start));
});

router.post('/logs/clear', (_req, res) => {
  logs.length = 0;
  res.json({ ok: true });
});

module.exports = { router };
