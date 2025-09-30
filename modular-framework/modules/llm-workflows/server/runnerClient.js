// modular-framework/modules/llm-workflows/server/runnerClient.js
const axios = require('axios');
const { logInfo, logWarn, logError } = require('./logger');

const RUNNERS = (() => {
  try { return JSON.parse(process.env.RUNNER_AGENTS || '{}'); }
  catch { return {}; }
})();

/**
 * Example RUNNER_AGENTS:
 * {
 *   "lab1": { "url":"http://lab1:4010", "token":"<runner-token>", "timeout_ms": 30000, "cwd":"/home/wf" },
 *   "lab2": { "url":"http://10.0.0.22:4010", "token":"<runner-token>" }
 * }
 */

function listRunners() {
  return Object.entries(RUNNERS).map(([name, cfg]) => ({
    name,
    url: (cfg.url || cfg.baseUrl || ''),
    default_cwd: (cfg.cwd || cfg.default_cwd || ''),
    timeout_ms: Number(cfg.timeout_ms || 20000)
  }));
}

function getRunner(name) {
  return RUNNERS[name];
}

async function pingRunner(name) {
  const cfg = RUNNERS[name];
  if (!cfg) return { ok:false, error:'unknown runner' };
  const url = (cfg.url || cfg.baseUrl || '').replace(/\/$/, '') + '/health';
  try {
    const r = await axios.get(url, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
      timeout: 3000
    });
    return { ok: true, data: r.data };
  } catch (e) {
    return { ok:false, error: e.message };
  }
}

async function execRemote({ target, kind, code, cwd, env, timeoutMs }) {
  const cfg = RUNNERS[target];
  if (!cfg) throw new Error(`Unknown runner: ${target}`);
  const base = (cfg.url || cfg.baseUrl || '').replace(/\/$/, '');
  const url = `${base}/exec`;
  const token = cfg.token || cfg.bearer || cfg.secret;

  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const body = (kind === 'bash')
    ? { type: 'bash', cmd: code, cwd, env, timeoutMs: Number(timeoutMs || cfg.timeout_ms || 20000) }
    : { type: 'python', script: code, cwd, env, timeoutMs: Number(timeoutMs || cfg.timeout_ms || 20000) };

  logInfo('runner.exec ->', { target, url, kind, cwd: body.cwd, timeoutMs: body.timeoutMs });

  try {
    const r = await axios.post(url, body, { headers, timeout: Math.min(body.timeoutMs + 5000, 120000) });
    const data = r.data || {};
    if (data.ok === false) throw new Error(data.error || 'runner returned not ok');
    return {
      exitCode: data.exitCode ?? data.code ?? 0,
      killed: !!data.killed,
      stdout: String(data.stdout || ''),
      stderr: String(data.stderr || '')
    };
  } catch (e) {
    logError('runner.exec error', { target, message: e.message });
    throw e;
  }
}

module.exports = { listRunners, getRunner, pingRunner, execRemote };
