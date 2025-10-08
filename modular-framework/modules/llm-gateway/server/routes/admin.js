const express = require('express'); const router = express.Router();
const { ah } = require('../utils/asyncHandler');
const { validate, str, oneOf, obj, num, bool } = require('../utils/validate');
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
router.get('/providers', ah(async (req, res) => {
  logInfo('GW /api/providers list', { ip: req.ip });
  res.json({ items: await listProviders() });
}));
router.get('/providers/:id', ah(async (req, res) => {
  logInfo('GW /api/providers get', { id: req.params.id, ip: req.ip });
  const p = await getProvider(Number(req.params.id));
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json({ provider: p });
}));
router.post('/providers', ah(async (req, res) => {
  logInfo('GW /api/providers create', { body: redactProvider(req.body), ip: req.ip });
  const p = validate(req.body || {}, {
    name: str().min(1),
    kind: oneOf(['openai','openai-compatible','ollama']),
    base_url: str().min(3),
    api_key: str().optional(),
    headers: obj().optional()
  });
  const created = await createProvider(p);
  res.json({ ok: true, provider: created });
}));

router.put('/providers/:id', ah(async (req, res) => {
  logInfo('GW /api/providers update', { id: req.params.id, body: redactProvider(req.body), ip: req.ip });
  const p = validate(req.body || {}, {
    name: str().min(1),
    kind: oneOf(['openai','openai-compatible','ollama']),
    base_url: str().min(3),
    api_key: str().optional(),
    headers: obj().optional()
  });  
  const updated = await updateProvider(Number(req.params.id), p);
  res.json({ ok: true, provider: updated });
}));
router.delete('/providers/:id', ah(async (req, res) => {
  logInfo('GW /api/providers delete', { id: req.params.id, ip: req.ip });
  await deleteProvider(Number(req.params.id));
  res.json({ ok: true });
}));

// Models
router.get('/models', ah(async (req, res) => {
  logInfo('GW /api/models list', { ip: req.ip });
  res.json({ items: await listModels() });
}));
router.get('/models/by-key/:key', ah(async (req, res) => {
  logInfo('GW /api/models by-key', { key: req.params.key, ip: req.ip });
  const m = await getModelByKey(req.params.key);
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json({ model: m });
}));
router.get('/models/:id', ah(async (req, res) => {
  logInfo('GW /api/models get', { id: req.params.id, ip: req.ip });
  const m = await getModel(Number(req.params.id));
  if (!m) return res.status(404).json({ error: 'not found' });
  res.json({ model: m });
}));
router.post('/models', ah(async (req, res) => {
  logInfo('GW /api/models create', { body: req.body, ip: req.ip });
  const m = validate(req.body || {}, {
    provider_id: num().min(1),
    model_name: str().min(1),
    key: str().optional(),
    display_name: str().optional(),
    mode: oneOf(['auto','chat','responses']).optional(),
    supports_responses: bool().optional(),
    supports_reasoning: bool().optional(),
    input_cost_per_million: num().min(0).optional(),
    output_cost_per_million: num().min(0).optional(),
    currency: str().min(1).optional()
  });
  const created = await createModel(m);
  res.json({ ok: true, model: created });
}));
router.put('/models/:id', ah(async (req, res) => {
  logInfo('GW /api/models update', { id: req.params.id, body: req.body, ip: req.ip });
  const m = validate(req.body || {}, {
    provider_id: num().min(1),
    model_name: str().min(1),
    key: str().optional(),
    display_name: str().optional(),
    mode: oneOf(['auto','chat','responses']).optional(),
    supports_responses: bool().optional(),
    supports_reasoning: bool().optional(),
    input_cost_per_million: num().min(0).optional(),
    output_cost_per_million: num().min(0).optional(),
    currency: str().min(1).optional()
  });  const updated = await updateModel(Number(req.params.id), m);
  res.json({ ok: true, model: updated });
}));
router.delete('/models/:id', ah(async (req, res) => {
  logInfo('GW /api/models delete', { id: req.params.id, ip: req.ip });
  await deleteModel(Number(req.params.id));
  res.json({ ok: true });
}));
module.exports = { router };
