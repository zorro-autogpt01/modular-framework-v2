// Minimal remote runner agent (executes on THIS machine)
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.PORT || 4010);
const RUNNER_TOKEN = process.env.RUNNER_TOKEN || '';
const RUNNER_BASE_DIR = (process.env.RUNNER_BASE_DIR || '').trim(); // restrict cwd to this base (optional but recommended)
const DEFAULT_TIMEOUT = Number(process.env.RUNNER_DEFAULT_TIMEOUT_MS || 20000);
const ALLOW_ENV = String(process.env.RUNNER_ALLOW_ENV || '').split(',').map(s => s.trim()).filter(Boolean); // allowlist for env passthrough

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '1mb' }));

function auth(req, res, next) {
  if (!RUNNER_TOKEN) return next();
  const hdr = req.headers['authorization'] || '';
  if (hdr === `Bearer ${RUNNER_TOKEN}`) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

function sanitizeCwd(cwd) {
  if (!cwd) return undefined;
  const clean = cwd.replace(/\0/g,'').trim();
  if (!RUNNER_BASE_DIR) return clean;
  const abs = path.resolve(clean);
  const base = path.resolve(RUNNER_BASE_DIR);
  if (!abs.startsWith(base)) throw new Error('cwd outside of allowed base');
  return abs;
}

function filterEnv(env) {
  const out = {};
  for (const k of ALLOW_ENV) {
    if (k && env && Object.prototype.hasOwnProperty.call(env, k)) out[k] = String(env[k]);
  }
  return out;
}

function runProc(cmd, args, { cwd, env, timeoutMs }, onStdout, onStderr) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...(env || {}) }
    });
    let killed = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, Math.max(1000, timeoutMs || DEFAULT_TIMEOUT));
    child.stdout.on('data', d => onStdout?.(d.toString()));
    child.stderr.on('data', d => onStderr?.(d.toString()));
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, killed }); });
  });
}

app.get('/health', auth, (_req, res) => {
  res.json({ ok: true, status: 'healthy', base_dir: RUNNER_BASE_DIR || null });
});

app.post('/exec', auth, async (req, res) => {
  try {
    const { type, cmd, script, cwd, env, timeoutMs } = req.body || {};
    const kind = String(type || '').toLowerCase();
    const safeCwd = sanitizeCwd(cwd);
    const safeEnv = filterEnv(env || {});

    if (!['bash','python'].includes(kind)) {
      return res.status(400).json({ ok:false, error:'unsupported type (bash|python only)' });
    }

    let stdout = '', stderr = '';
    if (kind === 'bash') {
      if (!cmd || typeof cmd !== 'string') return res.status(400).json({ ok:false, error:'cmd required' });
      const r = await runProc('bash', ['-lc', cmd], { cwd: safeCwd, env: safeEnv, timeoutMs },
        s => stdout += s, s => stderr += s);
      return res.json({ ok:true, exitCode: r.code, killed: r.killed, stdout, stderr });
    } else {
      if (!script || typeof script !== 'string') return res.status(400).json({ ok:false, error:'script required' });
      const r = await runProc('python3', ['-c', script], { cwd: safeCwd, env: safeEnv, timeoutMs },
        s => stdout += s, s => stderr += s);
      return res.json({ ok:true, exitCode: r.code, killed: r.killed, stdout, stderr });
    }
  } catch (e) {
    return res.status(500).json({ ok:false, error: e.message || 'exec failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Runner agent listening on :${PORT}`);
  if (RUNNER_BASE_DIR) console.log(`Restricted to base dir: ${RUNNER_BASE_DIR}`);
});
