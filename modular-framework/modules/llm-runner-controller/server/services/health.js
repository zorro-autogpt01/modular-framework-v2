const axios = require('axios');
const db = require('./db');
const events = require('./events');

function trim(u){ return String(u||'').replace(/\/+$/,''); }

async function pingAgentRow(a) {
  const url = trim(a.url);
  const token = a.token_plain;
  const started = Date.now();
  let status = 'offline', payload = null;
  try {
    const resp = await axios.get(`${url}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 5000
    });
    payload = resp.data || null;
    status = 'online';
  } catch (e) {
    status = 'offline';
    payload = { error: e.message };
  }
  const now = new Date().toISOString();
  const last = a.status;
  db.run('UPDATE agents SET status=?, last_seen_at=?, updated_at=? WHERE id=?', [status, now, now, a.id]);
  if (last !== status) {
    events.emit(`agent.${status}`, { id: a.id, name: a.name, last_status: last, payload });
  }
  const latency_ms = Date.now() - started;
  return { ok: status === 'online', latency_ms, payload };
}

async function pingNow(req, res) {
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'not found' });
  const r = await pingAgentRow(a);
  res.json(r);
}

async function proxy(req, res) {
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'not found' });

  try {
    const r = await axios.get(`${trim(a.url)}/health`, {
      headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
      timeout: 5000
    });
    res.json(r.data);
  } catch (e) {
    res.status(502).json({ error: e.message || 'health proxy failed' });
  }
}

function startScheduler() {
  const interval = Math.max(5, Number(process.env.HEALTH_INTERVAL_SEC || 15)) * 1000;
  setInterval(() => {
    try {
      const agents = db.all('SELECT * FROM agents');
      agents.forEach(a => pingAgentRow(a).catch(()=>{}));
    } catch {
      // ignore
    }
  }, interval);
}

module.exports = { pingNow, proxy, startScheduler };
