const express = require('express');
const router = express.Router();
const {
  readGlobalConfig, writeGlobalConfig,
  listProfiles, replaceAllProfiles
} = require('../db');
const { logInfo } = require('../logger');

function optionalAuth(req, res, next) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return next(); // dev-friendly
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${token}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

router.get('/config-store/global', optionalAuth, async (_req, res) => {
  try {
    const cfg = await readGlobalConfig();
    res.json({ ok: true, config: cfg || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'read failed' });
  }
});
router.put('/config-store/global', optionalAuth, async (req, res) => {
  const body = req.body || {};
  try {
    const saved = await writeGlobalConfig({
      provider: body.provider || null,
      baseUrl: body.baseUrl || null,
      apiKey: body.apiKey || '',
      model: body.model || null,
      temperature: body.temperature != null ? Number(body.temperature) : null,
      max_tokens: body.max_tokens != null ? Number(body.max_tokens) : null
    });
    logInfo('chat:config:global:updated', { ip: req.ip });
    res.json({ ok: true, config: saved });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'save failed' });
  }
});

router.get('/config-store/profiles', optionalAuth, async (_req, res) => {
  try {
    const items = await listProfiles();
    res.json({ ok: true, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'read failed' });
  }
});
router.put('/config-store/profiles', optionalAuth, async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  try {
    const saved = await replaceAllProfiles(items);
    logInfo('chat:config:profiles:replaced', { count: saved.length });
    res.json({ ok: true, items: saved });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'replace failed' });
  }
});

module.exports = { router };
