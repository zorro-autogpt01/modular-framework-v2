const db = require('./services/db');

function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return '';
  return h.slice('Bearer '.length).trim();
}

function requireAdmin(req, res, next) {
  const token = process.env.INTERNAL_API_TOKEN || '';
  if (!token) return res.status(503).json({ error: 'admin token not configured' });
  const got = bearerToken(req);
  if (got && got === token) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

function requireAdminOptional(_req, _res, next) {
  // Allow anonymous reads for discovery; protect sensitive fields in handlers themselves.
  next();
}

function requireReg(req, res, next) {
  const t = process.env.RUNNER_REG_TOKEN || '';
  if (!t) return res.status(503).json({ error: 'registration disabled' });
  const got = bearerToken(req);
  if (got && got === t) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

async function requireAgentAuth(req, res, next) {
  const { id } = req.params || {};
  const token = bearerToken(req);
  if (!id || !token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const agent = db.one('SELECT id, token_plain FROM agents WHERE id = ?', [id]);
    if (!agent) return res.status(404).json({ error: 'not found' });
    // NOTE: Minimal MVP uses token_plain. For production, store encrypted and verify against hash.
    if (String(agent.token_plain || '') !== token) return res.status(401).json({ error: 'unauthorized' });
    return next();
  } catch (e) {
    return res.status(500).json({ error: 'auth error' });
  }
}

module.exports = { requireAdmin, requireAdminOptional, requireReg, requireAgentAuth };
