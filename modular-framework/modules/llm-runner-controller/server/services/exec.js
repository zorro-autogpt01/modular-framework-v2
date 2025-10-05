const crypto = require('crypto');
const axios = require('axios');
const db = require('./db');
const events = require('./events');

function uuid(){ return crypto.randomUUID(); }
function sha256(s){ return crypto.createHash('sha256').update(String(s||''),'utf8').digest('hex'); }
function head(s, n=4000){ return String(s||'').slice(0, n); }

async function run(req, res) {
  const { id } = req.params;
  const { type, cmd, code, script, cwd, env, timeoutMs } = req.body || {};
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'not found' });

  const kind = (type || (script ? 'python' : 'bash')).toLowerCase();
  const payload = kind === 'bash'
    ? { type: 'bash', cmd: cmd || code || '', cwd, env, timeoutMs }
    : { type: 'python', script: script || code || '', cwd, env, timeoutMs };

  const runId = uuid();
  const started = Date.now();
  const envRedacted = env && typeof env === 'object' ? Object.fromEntries(Object.keys(env).map(k => [k, '***REDACTED***'])) : null;

  try {
    const r = await axios.post(`${a.url.replace(/\/+$/, '')}/exec`, payload, {
      headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
      timeout: Math.max(4000, Number(timeoutMs || 20000) + 4000)
    });

    const out = r.data || {};
    const duration_ms = Date.now() - started;
    db.run(
      'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [runId, a.id, 'controller', kind, sha256(payload.cmd || payload.script || ''), cwd || null, JSON.stringify(envRedacted || {}), out.ok ? 'ok' : 'error', Number(out.exitCode ?? -1), head(out.stdout), head(out.stderr), duration_ms]
    );
    events.emit('run.finished', { id: runId, agent_id: a.id, status: out.ok ? 'ok' : 'error', exit_code: out.exitCode });

    res.json({
      ok: !!out.ok || (typeof out.exitCode === 'number' && out.exitCode === 0),
      exitCode: out.exitCode ?? null,
      stdout: out.stdout || '',
      stderr: out.stderr || '',
      killed: !!out.killed
    });
  } catch (e) {
    const duration_ms = Date.now() - started;
    const msg = e?.response?.data?.error || e.message || 'exec failed';
    db.run(
      'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      [runId, a.id, 'controller', kind, sha256(payload.cmd || payload.script || ''), cwd || null, JSON.stringify(envRedacted || {}), 'error', -1, '', head(msg), duration_ms]
    );
    events.emit('run.finished', { id: runId, agent_id: a.id, status: 'error', exit_code: -1 });
    res.status(502).json({ ok: false, error: msg });
  }
}

module.exports = { run };
