// Minimal logging orchestrator (Express + JSON file storage)
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const fetch = (...a) => import('node-fetch').then(({default: f}) => f(...a));

const PORT = process.env.PORT || 3015;
const ORCH_TOKEN = process.env.ORCH_TOKEN || ''; // optional bearer for writes
const DATA_DIR = process.env.DATA_DIR || '/data';
const FILE = path.join(DATA_DIR, 'config.json');

// Seed services from env (JSON array of {name, logging_url})
const SERVICES_ENV = process.env.SERVICES || '[]';
let SERVICES = [];
try { SERVICES = JSON.parse(SERVICES_ENV); } catch {}

fs.mkdirSync(DATA_DIR, { recursive: true });

// Basic file store (desired state + rollouts)
function readStore() {
  if (!fs.existsSync(FILE)) {
    const seed = {
      desired: {
        // global defaults
        level: 'info',
        sampling_rate: 1.0,
        console: true,
        buffer_max: 1000,
        level_overrides: {},        // e.g. {"llm":"debug","http_access":"info"}
        fields: { service: 'orchestrated' },
        hec: {
          enabled: !!(process.env.SPLUNK_HEC_URL && process.env.SPLUNK_HEC_TOKEN),
          url: process.env.SPLUNK_HEC_URL || null,
          token: process.env.SPLUNK_HEC_TOKEN || null,
          index: process.env.SPLUNK_INDEX || null,
          source: process.env.SPLUNK_SOURCE || 'platform'
        }
      },
      services: SERVICES.map(s => ({ ...s, id: s.name })),
      rollouts: [] // {ts, by, services:[{name, ok, status, body}] , config}
    };
    fs.writeFileSync(FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}
function writeStore(obj) { fs.writeFileSync(FILE, JSON.stringify(obj, null, 2)); }

let STORE = readStore();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use('/admin', express.static(path.join(__dirname, '..', 'public')));

// ---- auth (for mutating endpoints) ----
function requireAuth(req, res, next) {
  if (!ORCH_TOKEN) return next(); // open if token not set
  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${ORCH_TOKEN}`) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

// ---- Services registry ----
app.get('/api/logging-admin/services', (_req, res) => {
  res.json({ items: STORE.services || [] });
});
app.post('/api/logging-admin/services', requireAuth, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.logging_url) return res.status(400).json({ error: 'name, logging_url required' });
  const exists = (STORE.services || []).find(s => s.name === b.name);
  if (exists) return res.status(409).json({ error: 'exists' });
  const row = { id: b.name, name: b.name, logging_url: b.logging_url, notes: b.notes || null };
  STORE.services.push(row);
  writeStore(STORE);
  res.json({ ok: true, service: row });
});
app.delete('/api/logging-admin/services/:name', requireAuth, (req, res) => {
  STORE.services = (STORE.services || []).filter(s => s.name !== req.params.name);
  writeStore(STORE);
  res.json({ ok: true });
});

// ---- Desired config CRUD ----
app.get('/api/logging-admin/config', (_req, res) => {
  const cfg = { ...STORE.desired };
  if (cfg?.hec?.token) cfg.hec = { ...cfg.hec, token: '***REDACTED***' };
  res.json({ desired: cfg });
});
app.put('/api/logging-admin/config', requireAuth, (req, res) => {
  // shallow merge for simplicity; client should send full hec block
  STORE.desired = { ...STORE.desired, ...(req.body || {}) };
  writeStore(STORE);
  const red = { ...STORE.desired };
  if (red?.hec?.token) red.hec = { ...red.hec, token: '***REDACTED***' };
  res.json({ ok: true, desired: red });
});

// ---- Fan-out push to all or a single service ----
async function pushOne(svc, cfg, dryRun=false) {
  const url = svc.logging_url;
  try {
    const u = new URL(url);
    // PUT ?dry_run=1 or =0
    const target = `${u.origin}${u.pathname}?dry_run=${dryRun ? 1 : 0}`;
    const resp = await fetch(target, {
      method: 'PUT',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(cfg)
    });
    const body = await resp.text();
    let parsed; try { parsed = JSON.parse(body); } catch { parsed = body; }
    return { name: svc.name, ok: resp.ok, status: resp.status, body: parsed };
  } catch (e) {
    return { name: svc.name, ok: false, status: 0, body: String(e) };
  }
}

app.post('/api/logging-admin/push', requireAuth, async (req, res) => {
  const service = req.query.service || null;
  const dryRun = String(req.query.dry_run || '0') === '1';
  const cfg = STORE.desired;
  const targets = (STORE.services || []).filter(s => !service || s.name === service);
  if (!targets.length) return res.status(404).json({ error: 'no services' });
  const results = await Promise.all(targets.map(s => pushOne(s, cfg, dryRun)));
  if (!dryRun) {
    STORE.rollouts.unshift({
      ts: new Date().toISOString(),
      by: 'api',
      services: results,
      config: { ...cfg, hec: { ...cfg.hec, token: cfg?.hec?.token ? '***REDACTED***' : null } }
    });
    STORE.rollouts = STORE.rollouts.slice(0, 50);
    writeStore(STORE);
  }
  res.json({ ok: true, dry_run: dryRun, results });
});

// ---- Quick status gather (GET config from services) ----
async function statusOne(svc) {
  try {
    const resp = await fetch(svc.logging_url, { method: 'GET' });
    const json = await resp.json();
    return { name: svc.name, ok: resp.ok, status: resp.status, effective: json.effective || json };
  } catch (e) {
    return { name: svc.name, ok: false, status: 0, error: String(e) };
  }
}
app.get('/api/logging-admin/status', async (_req, res) => {
  const results = await Promise.all((STORE.services || []).map(statusOne));
  res.json({ items: results });
});

app.get('/api/logging-admin/rollouts', (_req, res) => {
  res.json({ items: STORE.rollouts || [] });
});

app.listen(PORT, () => {
  console.log(`logging-orchestrator listening on :${PORT}`);
});
