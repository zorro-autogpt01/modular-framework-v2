const express = require('express');
const router = express.Router();

router.get('/info', (_req, res) => res.json({ module: 'llm-chat', version: '1.5.0', status: 'ready' }));

module.exports = { router };
