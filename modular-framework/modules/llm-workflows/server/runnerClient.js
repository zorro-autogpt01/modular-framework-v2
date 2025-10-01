// runnerClient.js (make sure it looks like this)
const axios = require('axios');
const { logWarn, logError } = require('./logger');

const runners = new Map();

function trim(u){ return String(u||'').replace(/\/+$/,''); }

function listRunners() {
  // never expose token
  return [...runners.values()].map(({token, ...r}) => r);
}
function getRunner(name) { return runners.get(name) || null; }
function upsertRunner({ name, url, token, default_cwd }) {
  if (!name || !url || !token) throw new Error('name, url, token required');
  runners.set(name, { name, url: trim(url), token, default_cwd });
  const { token: _t, ...safe } = runners.get(name);
  return safe;
}
function removeRunner(name) { runners.delete(name); }

async function pingRunner(name) {
  const r = getRunner(name);
  if (!r) return { ok:false, error:'not_found' };
  try {
    const resp = await axios.get(`${trim(r.url)}/health`, {
      headers: r.token ? { Authorization: `Bearer ${r.token}` } : {},
      timeout: 5000
    });
    return resp.data;
  } catch (e) {
    const status = e?.response?.status || 0;
    const msg = e?.response?.data?.error || e.message;
    logWarn('runner_ping_failed', { name, status, msg });
    return { ok:false, error: msg };
  }
}

async function execRemote({ target, kind, code, cwd, env, timeoutMs }) {
  const r = getRunner(target);
  if (!r) throw new Error(`runner "${target}" not found`);
  const body = kind === 'bash'
    ? { type:'bash', cmd: code, cwd, env, timeoutMs }
    : { type:'python', script: code, cwd, env, timeoutMs };
  try {
    const resp = await axios.post(`${trim(r.url)}/exec`, body, {
      headers: r.token ? { Authorization: `Bearer ${r.token}` } : {},
      timeout: Math.max(2000, Number(timeoutMs||20000) + 2000)
    });
    return resp.data;
  } catch (e) {
    const status = e?.response?.status || 0;
    const msg = e?.response?.data?.error || e.message;
    logError('runner_exec_failed', { target, status, msg });
    throw new Error(msg);
  }
}

module.exports = { listRunners, getRunner, upsertRunner, removeRunner, pingRunner, execRemote };
