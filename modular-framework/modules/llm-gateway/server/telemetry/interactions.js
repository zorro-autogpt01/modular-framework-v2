// Lightweight in-memory interaction tracker with SSE fanout
const { EventEmitter } = require('events');
const bus = new EventEmitter();
bus.setMaxListeners(0); // unlimited consumers

// Keep recent finished interactions (ring buffer)
const MAX_HISTORY = 200;
const recent = [];

// Track ongoing by id
const live = new Map();

/**
 * Start tracking an interaction
 * @param {Object} i { id, model, provider, stream, ip, started_at, meta? }
 */
function start(i) {
  const id = i?.id;
  if (!id) return;
  const rec = {
    id,
    model: i.model || null,
    provider: i.provider || null,
    stream: !!i.stream,
    ip: i.ip || null,
    started_at: i.started_at || new Date().toISOString(),
    meta: i.meta || null,
    state: 'running',
  };
  live.set(id, rec);
  bus.emit('event', { type: 'started', data: rec });
}

/**
 * Append incremental info (e.g., output chars, token counts so far)
 */
function update(id, patch) {
  const rec = live.get(id);
  if (!rec) return;
  Object.assign(rec, patch || {});
  bus.emit('event', { type: 'updated', data: rec });
}

/**
 * Mark as finished (success). Add to history.
 */
function finish(id, stats) {
  const rec = live.get(id);
  const base = rec || { id, started_at: new Date().toISOString() };
  const done = {
    ...base,
    ...stats,
    finished_at: (stats && stats.finished_at) || new Date().toISOString(),
    state: 'done',
  };
  live.delete(id);
  recent.push(done);
  while (recent.length > MAX_HISTORY) recent.shift();
  bus.emit('event', { type: 'finished', data: done });
}

/**
 * Mark as errored. Add to history.
 */
function fail(id, err) {
  const rec = live.get(id);
  const base = rec || { id, started_at: new Date().toISOString() };
  const done = {
    ...base,
    error: (err && (err.message || err)) || 'error',
    finished_at: new Date().toISOString(),
    state: 'error',
  };
  live.delete(id);
  recent.push(done);
  while (recent.length > MAX_HISTORY) recent.shift();
  bus.emit('event', { type: 'finished', data: done });
}

function listRecent(limit = 20) {
  const n = Math.max(1, Math.min(Number(limit || 20), MAX_HISTORY));
  return recent.slice(-n).reverse();
}

function listLive() {
  return Array.from(live.values());
}

/**
 * Attach an SSE client (returns an unsubscribe function)
 */
function attachSSE(res) {
  const send = (evt) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch (_) {}
  };
  const handler = (evt) => send(evt);
  bus.on('event', handler);
  return () => bus.off('event', handler);
}

module.exports = { start, update, finish, fail, listRecent, listLive, attachSSE };
