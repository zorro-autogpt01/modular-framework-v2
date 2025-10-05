const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');
const events = require('./events');

function uuid(){ return crypto.randomUUID(); }

async function trigger(req, res) {
  const { id } = req.params;
  const { target, strategy } = req.body || {};
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const updId = uuid();

  db.run('INSERT INTO updates (id, agent_id, target, strategy, status, logs) VALUES (?,?,?,?,?,?)',
    [updId, a.id, target || null, strategy || 'now', 'queued', '']);

  // Best-effort call /update on agent if available
  try {
    const r = await axios.post(`${a.url.replace(/\/+$/, '')}/update`, { target, strategy }, {
      headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
      timeout: 15000
    });
    db.run('UPDATE updates SET status=?, logs=?, updated_at=datetime("now") WHERE id=?',
      ['done', JSON.stringify(r.data || {}), updId]);
    events.emit('agent.updated', { agent_id: a.id, update_id: updId, status: 'done' });
  } catch (e) {
    db.run('UPDATE updates SET status=?, logs=?, updated_at=datetime("now") WHERE id=?',
      ['error', e.message || 'update failed', updId]);
  }

  res.json({ ok: true, id: updId });
}

function get(req, res) {
  const { updId } = req.params;
  const r = db.one('SELECT * FROM updates WHERE id = ?', [updId]);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.json({ id: r.id, agent_id: r.agent_id, target: r.target, strategy: r.strategy, status: r.status, logs: r.logs });
}

module.exports = { trigger, get };
