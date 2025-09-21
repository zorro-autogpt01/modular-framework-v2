const express = require('express');
const router = express.Router();
router.get('/info', (_req, res) => res.json({ module: 'llm-gateway', version: '0.1.0', status: 'ready' }));
module.exports = { router };

