const express = require('express');
const router = express.Router();
const { recentUsage } = require('../db');

router.get('/usage', async (req, res) => {
  const limit = Math.min(Number(req.query.limit || 200), 2000);
  res.json({ items: await recentUsage(limit) });
});

module.exports = { router };

