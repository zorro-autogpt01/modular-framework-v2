const express = require('express');
const router = express.Router();

router.get('/health', (_req, res) => res.json({ status: 'healthy' }));

module.exports = { router };
