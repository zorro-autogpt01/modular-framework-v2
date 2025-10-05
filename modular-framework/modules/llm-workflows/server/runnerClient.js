// runnerClient.js
const axios = require('axios');
const { logWarn, logError } = require('./logger');

const runners = new Map(); // local (legacy) mode
const CTRL_BASE = (process.env.LLM_RUNNER_CONTROLLER_BASE || process.env.LLM_RUNNER_CONTROLLER_URL || '').replace(/\/+$/,'');

// Helper
function trim(u){ return String(u||'').replace(/\/+$/,''); }

function getAdminHeaders() {
  const tok = process.env.INTERNAL_API_TOKEN || '';
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

/** Always returns an ARRAY. In controller mode we return controller agents (no tokens). */
async function listRunners() {
  if (CTRL_BASE) {
    try {
      const url = `${CTRL_BASE}/catalog`;
      const r = await axios.get(url, { headers: getAdminHeaders(), timeout: 8000 });
      const arr = Array.isArray(r.data?.agents) ? r.data.agents : [];
      // Normalize to the shape the UI expects
      // NOTE: controller catalog doesn’t include agent URL (by design).
      return arr.map(a => ({
        name: a.name,
        url: null,                    // not exposed by controller
        default_cwd: a.default_cwd || null,
        status: a.status || 'offline',
        via: 'controller'
      }));
    } catch (e) {
      logWarn('ctrl_list_failed', { msg: e.message });
      return [];
    }
  }
  // Legacy local mode (array)
  return [...runners.values()].map(({ token, ...r }) => r);
}

function getRunner(name) {
  if (CTRL_BASE) {
    // In controller mode, we resolve by name only; URL/token are not used directly.
    return { name, via: 'controller' };
  }
  return runners.get(name) || null;
}

/** In controller mode we ignore local upserts. */
function upsertRunner({ name, url, token, default_cwd }) {
  if (CTRL_BASE) {
    // Provide a visible log line (you’re already seeing this)
    require('./logger').logInfo('runner_upsert_ignored_controller_mode', { name });
    return { name };
  }
  if (!name || !url || !token) throw new Error('name, url, token required');
  runners.set(name, { name, url: trim(url), token, default_cwd });
  const { token: _t, ...safe } = runners.get(name);
  return safe;
}

function removeRunner(name) {
  if (CTRL_BASE) return; // controller-managed
  runners.delete(name);
}

/** Execute via controller when in controller mode, otherwise direct to runner. */
async function execRemote({ target, kind, code, cwd, env, timeoutMs }) {
  if (!target) throw new Error('runner target required');
  const r = getRunner(target);
  if (!r) throw new Error(`runner "${target}" not found`);

  const body = kind === 'bash'
    ? { type: 'bash', cmd: code, cwd, env, timeoutMs }
    : { type: 'python', script: code, cwd, env, timeoutMs };

  try {
    if (CTRL_BASE) {
      // Use controller proxy: /api/llm-runner/agents/:id/exec
      const url = `${CTRL_BASE}/agents/${encodeURIComponent(target)}/exec`;
      const resp = await axios.post(url, body, { headers: getAdminHeaders(), timeout: Math.max(2000, Number(timeoutMs || 20000) + 2000) });
      return resp.data;
    } else {
      // Legacy direct-to-runner
      const resp = await axios.post(`${trim(r.url)}/exec`, body, {
        headers: r.token ? { Authorization: `Bearer ${r.token}` } : {},
        timeout: Math.max(2000, Number(timeoutMs || 20000) + 2000)
      });
      return resp.data;
    }
  } catch (e) {
    const status = e?.response?.status || 0;
    const msg = e?.response?.data?.error || e.message;
    logError('runner_exec_failed', { target, status, msg });
    throw new Error(msg);
  }
}

module.exports = { listRunners, getRunner, upsertRunner, removeRunner, execRemote };
