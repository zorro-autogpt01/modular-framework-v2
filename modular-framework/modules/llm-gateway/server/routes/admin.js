const express = require('express');
const router = express.Router();
const {
  listProviders, getProvider, createProvider, updateProvider, deleteProvider,
  listModels, getModel, getModelByKey, createModel, updateModel, deleteModel
} = require('../db');
const { logInfo, logDebug } = require('../logger');

function redactProvider(p = {}) {
  const c = { ...(p || {}) };
  if (c.api_key) c.api_key = '***REDACTED***';
  return c;
}

// Providers
router.get('/providers', async (req, res) => {
  logInfo('GW /api/providers list', { ip: req.ip });
  res.json({ items: await listProviders() });
});
router.get('/providers/:id', async (req, res) => {
  logInfo('GW /api/providers get', { id: req.params.id, ip: req.ip });
  const p = await getProvider(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ provider: p });
});
router.post('/providers', async (req, res) => {
  logInfo('GW /api/providers create', { body: redactProvider(req.body), ip: req.ip });
  const p = req.body || {};
  if (!p.name || !p.kind || !p.base_url) return res.status(400).json({ error: 'name, kind, base_url required' });
  const created = await createProvider(p);
  res.json({ ok: true, provider: created });
});
router.put('/providers/:id', async (req, res) => {
  logInfo('GW /api/providers update', { id: req.params.id, body: redactProvider(req.body), ip: req.ip });
  const p = req.body || {};
  const updated = await updateProvider(Number(req.params.id), p);
  res.json({ ok: true, provider: updated });
});
router.delete('/providers/:id', async (req, res) => {
  logInfo('GW /api/providers delete', { id: req.params.id, ip: req.ip });
  await deleteProvider(Number(req.params.id));
  res.json({ ok: true });
});

// Models
router.get('/models', async (req, res) => {
  logInfo('GW /api/models list', { ip: req.ip });
  res.json({ items: await listModels() });
});
router.get('/models/by-key/:key', async (req, res) => {
  logInfo('GW /api/models by-key', { key: req.params.key, ip: req.ip });
  const m = await getModelByKey(req.params.key);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json({ model: m });
});
router.get('/models/:id', async (req, res) => {
  logInfo('GW /api/models get', { id: req.params.id, ip: req.ip });
  const m = await getModel(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json({ model: m });
});
router.post('/models', async (req, res) => {
  logInfo('GW /api/models create', { body: req.body, ip: req.ip });
  const m = req.body || {};
  if (!m.provider_id || !m.model_name) return res.status(400).json({ error: 'provider_id, model_name required' });
  const created = await createModel(m);
  res.json({ ok: true, model: created });
});
router.put('/models/:id', async (req, res) => {
  logInfo('GW /api/models update', { id: req.params.id, body: req.body, ip: req.ip });
  const m = req.body || {};
  const updated = await updateModel(Number(req.params.id), m);
  res.json({ ok: true, model: updated });
});
router.delete('/models/:id', async (req, res) => {
  logInfo('GW /api/models delete', { id: req.params.id, ip: req.ip });
  await deleteModel(Number(req.params.id));
  res.json({ ok: true });
});

module.exports = { router };
