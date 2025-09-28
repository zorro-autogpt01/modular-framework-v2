import express from 'express';
import { initDb, listPresets, getPreset, createPreset, updatePreset, deletePreset } from './db.js';

const router = express.Router();

// Optional simple bearer auth for write ops (set INTERNAL_API_TOKEN in env)
function requireWriteAuth(req, res, next) {
  const token = process.env.INTERNAL_API_TOKEN;
  if (!token) return next();
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${token}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

router.get('/presets', async (_req, res) => {
  try { res.json({ ok: true, items: await listPresets() }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message || 'list failed' }); }
});

router.get('/presets/:id', async (req, res) => {
  try {
    const item = await getPreset(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'not found' });
    res.json({ ok: true, item });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || 'get failed' });
  }
});

router.post('/presets', requireWriteAuth, async (req, res) => {
  try { res.json({ ok: true, item: await createPreset(req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message || 'create failed' }); }
});

router.put('/presets/:id', requireWriteAuth, async (req, res) => {
  try { res.json({ ok: true, item: await updatePreset(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message || 'update failed' }); }
});

router.delete('/presets/:id', requireWriteAuth, async (req, res) => {
  try { await deletePreset(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message || 'delete failed' }); }
});

export { router };
