const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'workflows.json');

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE)) fs.writeFileSync(FILE, JSON.stringify({ items: [] }, null, 2));
}
function readAll() { ensureFile(); try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { items: [] }; } }
function writeAll(data) { ensureFile(); fs.writeFileSync(FILE, JSON.stringify(data, null, 2)); }

router.get('/workflows', (_req, res) => {
  const data = readAll();
  res.json({ items: data.items || [] });
});
router.get('/workflows/:id', (req, res) => {
  const data = readAll();
  const wf = (data.items || []).find(x => x.id === req.params.id);
  if (!wf) return res.status(404).json({ error: 'not found' });
  res.json({ workflow: wf });
});
router.post('/workflows', (req, res) => {
  const wf = req.body?.workflow;
  if (!wf || !wf.id) return res.status(400).json({ error:'workflow with id required' });
  const data = readAll();
  const idx = (data.items || []).findIndex(x => x.id === wf.id);
  if (idx >= 0) data.items[idx] = wf; else data.items.push(wf);
  writeAll(data);
  res.json({ ok:true, workflow: wf });
});
router.delete('/workflows/:id', (req, res) => {
  const data = readAll();
  const next = (data.items || []).filter(x => x.id !== req.params.id);
  writeAll({ items: next });
  res.json({ ok:true });
});

module.exports = { router };