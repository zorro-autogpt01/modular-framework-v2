const db = require('./db');

function deepMerge(a, b) {
  if (b === null || b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b) || typeof a !== 'object' || typeof b !== 'object') return b;
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = deepMerge(a[k], b[k]);
  return out;
}

function list(req, res) {
  const { scope, ref_id } = req.query || {};
  let rows = [];
  if (scope) {
    rows = ref_id
      ? db.all('SELECT * FROM configs WHERE scope = ? AND ref_id = ? ORDER BY version DESC', [scope, ref_id])
      : db.all('SELECT * FROM configs WHERE scope = ? ORDER BY version DESC', [scope]);
  } else {
    rows = db.all('SELECT * FROM configs ORDER BY created_at DESC LIMIT 200');
  }
  res.json({
    items: rows.map(r => ({
      id: r.id, scope: r.scope, ref_id: r.ref_id, version: r.version,
      name: r.name, data: JSON.parse(r.data || '{}'), created_at: r.created_at
    }))
  });
}

function nextVersion(scope, ref_id) {
  const r = db.one('SELECT MAX(version) as v FROM configs WHERE scope=? AND ref_id=?', [scope, ref_id]);
  return Number(r?.v || 0) + 1;
}

function create(req, res) {
  const { scope, ref_id, name, data } = req.body || {};
  if (!scope || !['global','group','agent'].includes(scope)) return res.status(400).json({ error: 'invalid scope' });
  const rid = ref_id || (scope === 'global' ? '*' : null);
  if (!rid) return res.status(400).json({ error: 'ref_id required for non-global' });

  const version = nextVersion(scope, rid);
  const id = `${scope}:${rid}:v${version}`;
  db.run('INSERT INTO configs (id, scope, ref_id, version, name, data) VALUES (?,?,?,?,?,?)',
    [id, scope, rid, version, name || null, JSON.stringify(data || {})]);

  res.json({ ok: true, id, version });
}

function assign(req, res) {
  const { id } = req.params; // agent id or name
  const body = req.body || {};
  const agent = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  const configId = body.config_id;
  const cfg = db.one('SELECT * FROM configs WHERE id = ?', [configId]);
  if (!cfg) return res.status(404).json({ error: 'config not found' });

  db.run('INSERT OR REPLACE INTO assignments (agent_id, config_id, effective_version) VALUES (?,?,?)',
    [agent.id, cfg.id, cfg.version]);

  res.json({ ok: true, effective_version: cfg.version });
}

function getEffective(agentRow) {
  // global
  const g = db.one('SELECT * FROM configs WHERE scope="global" ORDER BY version DESC LIMIT 1');
  let effective = g ? JSON.parse(g.data || '{}') : {};
  // group
  if (agentRow.group_id) {
    const grp = db.one('SELECT * FROM configs WHERE scope="group" AND ref_id=? ORDER BY version DESC LIMIT 1', [agentRow.group_id]);
    if (grp) effective = deepMerge(effective, JSON.parse(grp.data || '{}'));
  }
  // agent
  const ag = db.one('SELECT * FROM configs WHERE scope="agent" AND ref_id=? ORDER BY version DESC LIMIT 1', [agentRow.id]);
  if (ag) effective = deepMerge(effective, JSON.parse(ag.data || '{}'));

  // assignment overlay takes precedence if present
  const ass = db.one('SELECT a.config_id, c.data FROM assignments a JOIN configs c ON a.config_id = c.id WHERE a.agent_id=? ORDER BY effective_version DESC LIMIT 1', [agentRow.id]);
  if (ass) effective = deepMerge(effective, JSON.parse(ass.data || '{}'));

  const version = Date.now(); // simple monotonic version for pull
  return { version, data: effective };
}

function effective(req, res) {
  const { id } = req.params;
  const agent = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  return res.json(getEffective(agent));
}

function pullForAgent(req, res) {
  const { id } = req.params;
  const agent = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const eff = getEffective(agent);
  res.json({ ok: true, ...eff });
}

module.exports = { list, create, assign, effective, pullForAgent };
