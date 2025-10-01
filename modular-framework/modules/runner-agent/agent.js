/*
  runner-agent: lightweight exec agent for LLM Workflows
  Endpoints:
    GET  /health -> { ok, name, default_cwd, hostname, pid, uptimeSec, version }
    POST /exec   -> { ok, exitCode, killed, stdout, stderr }  (auth required)

  Auth:
    - All endpoints accept Authorization: Bearer <AGENT_TOKEN>
    - /exec requires valid token; /health does not (but will redact info if unauthorized)

  Registration (optional):
    - If REGISTER_URL, REGISTER_TOKEN, AGENT_NAME, AGENT_URL, AGENT_TOKEN are set,
      agent will POST {name,url,token,default_cwd} to REGISTER_URL with Bearer REGISTER_TOKEN
      to self-register with llm-workflows.
*/

const os = require('os');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const http = require('http');

const PORT = Number(process.env.PORT || 4010);
const AGENT_NAME = process.env.AGENT_NAME || 'runner';
const AGENT_TOKEN = process.env.AGENT_TOKEN || process.env.TOKEN || '';
const DEFAULT_CWD = (process.env.DEFAULT_CWD || process.cwd()).trim();
const REGISTER_URL = (process.env.REGISTER_URL || '').trim();
const REGISTER_TOKEN = (process.env.REGISTER_TOKEN || '').trim();
const AGENT_URL = (process.env.AGENT_URL || '').trim(); // public/inside-net URL that llm-workflows will use
const VERSION = '0.1.0';

function sanitizeCwd(cwd) {
  if (!cwd) return undefined;
  return String(cwd).replace(/\0/g, '').trim();
}

function withTimeout(child, timeoutMs) {
  let killed = false;
  const t = setTimeout(() => {
    killed = true;
    try { child.kill('SIGKILL'); } catch {}
  }, Math.max(1, Number(timeoutMs || 20000)));
  const clear = () => clearTimeout(t);
  return { killedRef: () => killed, clear };
}

function execBash({ cmd, cwd, env, timeoutMs=20000 }) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], { cwd: cwd || undefined, env: { ...process.env, ...(env||{}) } });
    let stdout = '', stderr = '';
    const tm = withTimeout(child, timeoutMs);
    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());
    child.on('close', (code, signal) => {
      tm.clear();
      resolve({ exitCode: code, signal, killed: tm.killedRef(), stdout, stderr });
    });
  });
}

function execPython({ script, cwd, env, timeoutMs=20000 }) {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', script], { cwd: cwd || undefined, env: { ...process.env, ...(env||{}) } });
    let stdout = '', stderr = '';
    const tm = withTimeout(child, timeoutMs);
    child.stdout.on('data', (d) => stdout += d.toString());
    child.stderr.on('data', (d) => stderr += d.toString());
    child.on('close', (code, signal) => {
      tm.clear();
      resolve({ exitCode: code, signal, killed: tm.killedRef(), stdout, stderr });
    });
  });
}

const app = express();
app.use(cors({ origin: true, credentials: false }));
app.use(bodyParser.json({ limit: '1mb' }));

function requireAuth(req, res, next) {
  if (!AGENT_TOKEN) return res.status(503).json({ ok: false, error: 'agent token not configured' });
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${AGENT_TOKEN}`) return next();
  return res.status(401).json({ ok: false, error: 'unauthorized' });
}

app.get('/health', (req, res) => {
  const authed = !!AGENT_TOKEN && (req.headers['authorization'] === `Bearer ${AGENT_TOKEN}`);
  const payload = {
    ok: true,
    name: AGENT_NAME,
    default_cwd: DEFAULT_CWD,
    hostname: os.hostname(),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    version: VERSION
  };
  if (!authed) {
    // don't leak details if no/invalid token; still signal ok
    return res.json({ ok: true, name: AGENT_NAME, version: VERSION });
  }
  res.json(payload);
});

app.post('/exec', requireAuth, async (req, res) => {
  const { type, cmd, script, cwd, env, timeoutMs } = req.body || {};
  const kind = String(type || '').toLowerCase();
  const runCwd = sanitizeCwd(cwd) || DEFAULT_CWD;

  if (!['bash', 'python'].includes(kind)) {
    return res.status(400).json({ ok: false, error: 'unsupported type (bash|python)' });
  }

  try {
    const r = kind === 'bash'
      ? await execBash({ cmd: String(cmd || ''), cwd: runCwd, env, timeoutMs })
      : await execPython({ script: String(script || ''), cwd: runCwd, env, timeoutMs });

    res.json({ ok: true, exitCode: r.exitCode, killed: r.killed, stdout: r.stdout, stderr: r.stderr });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// Self-register with llm-workflows if configured
async function selfRegister() {
  if (!REGISTER_URL || !REGISTER_TOKEN || !AGENT_NAME || !AGENT_URL || !AGENT_TOKEN) return;

  const payload = {
    name: AGENT_NAME,
    url: AGENT_URL.replace(/\/+$/, ''),
    token: AGENT_TOKEN,
    default_cwd: DEFAULT_CWD
  };

  const data = JSON.stringify(payload);
  const u = new URL(REGISTER_URL);
  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    path: u.pathname + (u.search || ''),
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
      'Authorization': `Bearer ${REGISTER_TOKEN}`
    }
  };
  const transport = u.protocol === 'https:' ? require('https') : require('http');

  await new Promise((resolve) => {
    const req = transport.request(opts, (resp) => {
      let body = '';
      resp.on('data', (c) => body += c.toString());
      resp.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.write(data);
    req.end();
  });
}

http.createServer(app).listen(PORT, async () => {
  console.log(`runner-agent "${AGENT_NAME}" listening on :${PORT}, default_cwd=${DEFAULT_CWD}`);
  try { await selfRegister(); } catch {}
});
