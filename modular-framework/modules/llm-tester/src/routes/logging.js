import { Router } from 'express';
import { getEffectiveLoggingConfig, setLoggingConfig, testLoggingSink } from '../logger.js';

const router = Router();

function requireInternalAuth(req, res, next) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return next();
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${token}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

router.get('/logging', requireInternalAuth, (_req, res) => {
  res.json({ effective: getEffectiveLoggingConfig(), redacted: true });
});

router.put('/logging', requireInternalAuth, (req, res) => {
  const dry = String(req.query.dry_run || '').toLowerCase() === '1';
  try {
    const result = setLoggingConfig(req.body || {}, { dryRun: dry });
    res.json({ ok: true, dry_run: dry, result });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || 'invalid config' });
  }
});

router.post('/logging/test', requireInternalAuth, async (_req, res) => {
  try {
    const r = await testLoggingSink();
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'test failed' });
  }
});

router.post('/logging/reload', requireInternalAuth, (_req, res) => {
  try {
    const result = setLoggingConfig({ _reload: true }, { dryRun: false });
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'reload failed' });
  }
});

export default router;
