// runnerClient.js -> delegate to llm-runner-controller
const axios = require('axios');
const { logWarn, logError } = require('./logger');

const BASE = (process.env.RUNNER_CONTROLLER_BASE || 'http://llm-runner-controller:4015/api/llm-runner').replace(/\/+$/, '');
function HDR() {
  const t = process.env.INTERNAL_API_TOKEN || '';
  return t ? { Authorization: `Bearer ${t}` } : {};
}

function trim(u){ return String(u||'').replace(/\/+$/, ''); }

async function listRunners() {
  try {
    const r = await axios.get(`${BASE}/agents`, { headers: HDR(), timeout: 10000 });
    const items = r.data?.items || [];
    // never expose token
    return items.map(a => ({ name: a.name, url: a.url, default_cwd: a.default_cwd }));
  } catch (e) {
    logWarn('controller_list_runners_failed', { msg: e.message });
    return [];
  }
}

async function getRunner(name) {
  try {
    const r = await axios.get(`${BASE}/agents/${encodeURIComponent(name)}`, { headers: HDR(), timeout: 7000 });
    const a = r.data || null;
    if (!a) return null;
    return { name: a.name, url: a.url, default_cwd: a.default_cwd };
  } catch {
    return null;
  }
}

async function upsertRunner({ name, url, token, default_cwd }) {
  try {
    const r = await axios.post(`${BASE}/agents`, { name, url: trim(url), token, default_cwd }, { headers: HDR(), timeout: 10000 });
    const a = r.data?.agent || {};
    return { name: a.name, url: a.url, default_cwd: a.default_cwd };
  } catch (e) {
    logError('controller_upsert_runner_failed', { msg: e.message });
    throw e;
  }
}

async function removeRunner(name) {
  try {
    await axios.delete(`${BASE}/agents/${encodeURIComponent(name)}`, { headers: HDR(), timeout: 10000 });
  } catch (e) {
    logError('controller_remove_runner_failed', { msg: e.message });
  }
}

async function pingRunner(name) {
  try {
    const r = await axios.get(`${BASE}/agents/${encodeURIComponent(name)}/health`, { headers: HDR(), timeout: 7000 });
    return r.data;
  } catch (e) {
    const status = e?.response?.status || 0;
    const msg = e?.response?.data?.error || e.message;
    logWarn('controller_ping_runner_failed', { name, status, msg });
    return { ok: false, error: msg };
  }
}

async function execRemote({ target, kind, code, cwd, env, timeoutMs }) {
  try {
    const body = (kind === 'bash')
      ? { type:'bash', cmd: code, cwd, env, timeoutMs }
      : { type:'python', script: code, cwd, env, timeoutMs };
    const r = await axios.post(`${BASE}/agents/${encodeURIComponent(target)}/exec`, body, { headers: HDR(), timeout: Math.max(4000, Number(timeoutMs || 20000) + 5000) });
    return r.data;
  } catch (e) {
    const status = e?.response?.status || 0;
    const msg = e?.response?.data?.error || e.message;
    logError('controller_exec_failed', { target, status, msg });
    throw new Error(msg);
  }
}

module.exports = { listRunners, getRunner, pingRunner, execRemote, upsertRunner, removeRunner };
