const axios = require('axios');
const crypto = require('crypto');
const db = require('./db');
const streams = require('./streams');
const events = require('./events');

function trim(u){ return String(u||'').replace(/\/+$/,''); }
function sha256(s){ return crypto.createHash('sha256').update(String(s||''),'utf8').digest('hex'); }
function head(s, n=4000){ return String(s||'').slice(0, n); }

async function startExec(req, res) {
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const { type, cmd, code, cwd, env, timeoutMs } = req.body || {};
  const kind = (type || (code ? 'python' : 'bash')).toLowerCase();
  const payload = kind === 'bash'
    ? { type: 'bash', cmd: cmd || code || '', cwd, env, timeoutMs, stream: true }
    : { type: 'python', script: code || '', cwd, env, timeoutMs, stream: true };
  const runId = streams.uuid();
  const started = Date.now();
  const envRedacted = env && typeof env === 'object' ? Object.fromEntries(Object.keys(env).map(k => [k, '***REDACTED***'])) : null;
  res.json({ ok: true, runId });

  (async () => {
    try {
      const r = await axios.post(`${trim(a.url)}/exec`, payload, {
        headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
        timeout: Math.max(4000, Number(timeoutMs || 20000) + 4000),
        responseType: 'stream'
      });
      await consumeStream({ runId, stream: r.data });
      // After stream ends, try to get final summary if the runner writes a trailer; otherwise fallback to code - assume 0
      const duration_ms = Date.now() - started;
      db.run(
        'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [runId, a.id, 'controller', kind, sha256(payload.cmd || payload.script || ''), cwd || null, JSON.stringify(envRedacted || {}), 'ok', 0, '', '', duration_ms]
      );
      streams.finished(runId, { ok: true, exitCode: 0 });
      events.emit('run.finished', { id: runId, agent_id: a.id, status: 'ok', exit_code: 0 });
    } catch (e) {
      const duration_ms = Date.now() - started;
      const msg = e?.response?.data?.error || e.message || 'exec stream failed';
      db.run(
        'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [runId, a.id, 'controller', kind, sha256(payload.cmd || payload.script || ''), cwd || null, JSON.stringify(envRedacted || {}), 'error', -1, '', head(msg), duration_ms]
      );
      streams.finished(runId, { ok: false, exitCode: -1, error: msg });
      events.emit('run.finished', { id: runId, agent_id: a.id, status: 'error', exit_code: -1 });
    }
  })();
}

async function startSshExec(req, res) {
  if (String(process.env.ENABLE_SSH || 'false').toLowerCase() !== 'true') {
    return res.status(503).json({ ok:false, error: 'SSH disabled (ENABLE_SSH=false)' });
  }
  const { id } = req.params;
  const a = db.one('SELECT * FROM agents WHERE id = ? OR name = ?', [id, id]);
  if (!a) return res.status(404).json({ error: 'agent not found' });

  const { host, user, port, cmd, env, cwd, timeoutMs, bastion, pty, knownHosts } = req.body || {};
  const payload = { host, user, port, cmd, env, cwd, timeoutMs, bastion, pty, knownHosts, stream: true };
  const runId = streams.uuid();
  const started = Date.now();
  const envRedacted = env && typeof env === 'object' ? Object.fromEntries(Object.keys(env).map(k => [k, '***REDACTED***'])) : null;
  res.json({ ok: true, runId });

  (async () => {
    try {
      const r = await axios.post(`${trim(a.url)}/ssh/exec`, payload, {
        headers: a.token_plain ? { Authorization: `Bearer ${a.token_plain}` } : {},
        timeout: Math.max(4000, Number(timeoutMs || 20000) + 6000),
        responseType: 'stream'
      });
      await consumeStream({ runId, stream: r.data });
      const duration_ms = Date.now() - started;
      db.run(
        'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms, host) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [runId, a.id, 'controller', 'ssh', sha256(cmd || ''), cwd || null, JSON.stringify(envRedacted || {}), 'ok', 0, '', '', duration_ms, host || null]
      );
      streams.finished(runId, { ok: true, exitCode: 0 });
      events.emit('run.finished', { id: runId, agent_id: a.id, status: 'ok', exit_code: 0, kind:'ssh', host });
    } catch (e) {
      const duration_ms = Date.now() - started;
      const msg = e?.response?.data?.error || e.message || 'ssh stream failed';
      db.run(
        'INSERT INTO runs (id, agent_id, requester, kind, code_hash, cwd, env_redacted, status, exit_code, stdout_head, stderr_head, duration_ms, host) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [runId, a.id, 'controller', 'ssh', sha256(cmd || ''), cwd || null, JSON.stringify(envRedacted || {}), 'error', -1, '', head(msg), duration_ms, host || null]
      );
      streams.finished(runId, { ok: false, exitCode: -1, error: msg });
      events.emit('run.finished', { id: runId, agent_id: a.id, status: 'error', exit_code: -1, kind:'ssh', host });
    }
  })();
}

async function consumeStream({ runId, stream }) {
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      const str = chunk.toString();
      // Try SSE 'data: {...}' lines
      const lines = str.split('\n');
      let any = false;
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        any = true;
        const payload = t.slice(5).trim();
        try {
          const evt = JSON.parse(payload);
          const s = evt?.stream || evt?.payload?.stream;
          const d = evt?.data || evt?.payload?.data || '';
          const which = (s === 'stderr' ? 'stderr' : 'stdout');
          streams.appendLog(runId, which, d);
        } catch {
          streams.appendLog(runId, 'stdout', payload);
        }
      }
      // Fallback: if not SSE-like, treat raw as stdout
      if (!any && str) {
        streams.appendLog(runId, 'stdout', str);
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

module.exports = { startExec, startSshExec }
