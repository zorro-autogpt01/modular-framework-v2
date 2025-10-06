const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');
const events = require('./events');

function uuid(){ return crypto.randomUUID(); }
function sha256(s){ return crypto.createHash('sha256').update(String(s||''),'utf8').digest('hex'); }
function head(s, n=4000){ return String(s||'').slice(0, n); }
function trim(u){ return String(u||'').replace(/\/+$/,''); }

async function exec(req, res) {
  if (String(process.env.ENABLE_SSH || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok:false, error: 'SSH disabled (ENABLE_SSH=false)' });
  }
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'agent not found' });

  const {
    host, user, port, cmd, env, cwd, timeoutMs,
    bastion, pty, knownHosts
  } = req.body || {};

  const payload = {
    host, user, port, cmd, env, cwd, timeoutMs,
    bastion, pty, knownHosts
  };

  const runId = uuid();
  const started = Date.now();
  const envRedacted = env && typeof env === 'object'
    ? Object.fromEntries(Object.keys(env).map(k => [k, '***REDACTED***']))
    : null;

  try {
    const r = await axios.post(`${trim(a.url)}/ssh/exec`, payload, {
      headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
      timeout: Math.max(4000, Number(timeoutMs || 20000) + 6000)
    });
    const out = r.data || {};
    const duration_ms = Date.now() - started;
    db.run(
      'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms, host) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [runId, a.id, 'controller', 'ssh', sha256(cmd || ''), cwd || null, JSON.stringify(envRedacted || {}), out.ok ? 'ok' : 'error', Number(out.exitCode ?? -1), head(out.stdout), head(out.stderr), duration_ms, host || null]
    );
    events.emit('run.finished', { id: runId, agent_id: a.id, status: out.ok ? 'ok' : 'error', exit_code: out.exitCode, kind: 'ssh', host });
    return res.json({
      ok: !!out.ok || (typeof out.exitCode === 'number' && out.exitCode === 0),
      exitCode: out.exitCode ?? null,
      stdout: out.stdout || '',
      stderr: out.stderr || '',
      killed: !!out.killed,
      timedOut: !!out.timedOut
    });
  } catch (e) {
    const duration_ms = Date.now() - started;
    const msg = e?.response?.data?.error || e.message || 'ssh exec failed';
    db.run(
      'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms, host) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [runId, a.id, 'controller', 'ssh', sha256(cmd || ''), cwd || null, JSON.stringify(envRedacted || {}), 'error', -1, '', head(msg), duration_ms, host || null]
    );
    events.emit('run.finished', { id: runId, agent_id: a.id, status: 'error', exit_code: -1, kind: 'ssh', host });
    return res.status(502).json({ ok:false, error: msg });
  }
}

module.exports = { exec };async function upload(req, res) {
  if (String(process.env.ENABLE_SSH || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok:false, error: 'SSH disabled (ENABLE_SSH=false)' });
  }
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const body = req.body || {};
  try {
    const r = await require('axios').post(`${(String(a.url||'')).replace(/\/+$/,'')}/ssh/upload`, body, {
      headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
      timeout: 300000
    });
    res.json(r.data || { ok: true });
  } catch (e) {
    res.status(502).json({ ok:false, error: e?.response?.data?.error || e.message || 'upload failed' });
  }
}

async function download(req, res) {
  if (String(process.env.ENABLE_SSH || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok:false, error: 'SSH disabled (ENABLE_SSH=false)' });
  }
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const body = req.body || {};
  try {
    const r = await require('axios').post(`${(String(a.url||'')).replace(/\/+$/,'')}/ssh/download`, body, {
      headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
      timeout: 300000
    });
    const out = r.data || {};
    const b64 = out.contentBase64 || out.base64 || null;
    if (!b64) return res.status(502).json({ ok:false, error:'runner did not return base64 content' });
    const buf = Buffer.from(b64, 'base64');
    const name = out.name || body.path?.split('/').pop() || 'download.bin';
    const mime = out.mime || 'application/octet-stream';
    const runId = body.runId || streams.uuid();
    const art = require('./artifacts').saveBuffer({ runId, name, buf, mime });
    res.json({ ok: true, artifactId: art.id, name: art.name, size: art.size, mime: art.mime });
  } catch (e) {
    res.status(502).json({ ok:false, error: e?.response?.data?.error || e.message || 'download failed' });
  }
}

module.exports = { exec, upload, download };

