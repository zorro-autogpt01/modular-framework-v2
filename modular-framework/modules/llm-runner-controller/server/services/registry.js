const crypto = require('crypto');
const argon2 = require('argon2');
const axios = require('axios');
const db = require('./db');
const events = require('./events');

function uuid() {
  return crypto.randomUUID();
}

function redactedAgentRow(a) {
  return {
    id: a.id, name: a.name, url: a.url, default_cwd: a.default_cwd || null,
    group_id: a.group_id || null, labels: a.labels ? JSON.parse(a.labels) : {},
    status: a.status || 'offline', last_seen_at: a.last_seen_at || null, version: a.version || null
  };
}

async function verifyAgent(url, token) {
  try {
    const r = await axios.get(`${url.replace(/\/+$/, '')}/health`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 5000
    });
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function list(_req, res) {
  const rows = db.all('SELECT * FROM agents ORDER BY name ASC');
  res.json({ items: rows.map(redactedAgentRow) });
}

async function get(req, res) {
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'not found' });
  return res.json(redactedAgentRow(a));
}

async function upsert(req, res) {
  const { name, url, token, default_cwd, group, labels } = req.body || {};
  if (!name || !url || !token) return res.status(400).json({ error: 'name, url, token required' });

  const exists = db.one('SELECT * FROM agents WHERE name = ?', [name]);

  const id = exists?.id || uuid();
  const now = new Date().toISOString();
  const lbl = labels ? JSON.stringify(labels) : null;

  const token_hash = await argon2.hash(token);

  db.txn(() => {
    if (exists) {
      db.run(
        'UPDATE agents SET url=?, token_hash=?, token_plain=?, default_cwd=?, group_id=?, labels=?, updated_at=? WHERE id=?',
        [url, token_hash, token, default_cwd || null, group || null, lbl, now, exists.id]
      );
    } else {
      db.run(
        'INSERT INTO agents (id, name, url, token_hash, token_plain, default_cwd, group_id, labels, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [id, name, url, token_hash, token, default_cwd || null, group || null, lbl, 'offline', now, now]
      );
    }
  });

  const a = db.one('SELECT * FROM agents WHERE id = ?', [id]);
  res.json({ ok: true, agent: redactedAgentRow(a) });
}

async function selfRegister(req, res) {
  const { name, url, token, default_cwd } = req.body || {};
  if (!name || !url || !token) return res.status(400).json({ error: 'name, url, token required' });
  const check = await verifyAgent(url, token);
  if (!check.ok) {
    // do not fail hard; allow deferred health
  }
  req.body.group = null;
  req.body.labels = { source: 'self' };
  return upsert(req, res);
}

async function remove(req, res) {
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.json({ ok: true, removed: 0 });
  db.run('DELETE FROM agents WHERE id = ?', [a.id]);
  events.emit('agent.removed', { id: a.id, name: a.name });
  res.json({ ok: true, removed: 1 });
}

async function catalog(_req, res) {
  const rows = db.all('SELECT id, name, default_cwd, labels, status FROM agents ORDER BY name ASC');
  res.json({
    agents: rows.map(r => ({
      id: r.id, name: r.name, default_cwd: r.default_cwd || null,
      labels: r.labels ? JSON.parse(r.labels) : {}, status: r.status || 'offline'
    }))
  });
}

module.exports = { list, get, upsert, selfRegister, remove, catalog };
