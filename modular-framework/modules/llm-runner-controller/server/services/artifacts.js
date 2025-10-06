const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const BASE_DIR = process.env.ARTIFACTS_DIR || path.join(process.cwd(), 'app', 'data', 'artifacts');
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(BASE_DIR);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function uuid() { return crypto.randomUUID(); }

function saveBuffer({ runId, name, buf, mime = 'application/octet-stream' }) {
  const id = uuid();
  const runDir = path.join(BASE_DIR, runId);
  ensureDir(runDir);
  const safeName = String(name || 'artifact.bin').replace(/[^\w.\-]+/g, '_').slice(0, 200) || 'artifact.bin';
  const filePath = path.join(runDir, safeName);
  fs.writeFileSync(filePath, buf);
  const size = fs.statSync(filePath).size;
  const hash = sha256(buf);
  const url = `/api/llm-runner/artifacts/${encodeURIComponent(id)}/raw`;
  db.run('INSERT INTO artifacts (id, run_id, name, mime, size, sha256, store_url) VALUES (?,?,?,?,?,?,?)',
    [id, runId, safeName, mime, size, hash, url])
    return { id, run_id: runId, name: safeName, mime, size, sha256: hash, store_url: url };
}

function readFileById(id) {
  const row = db.one('SELECT * FROM artifacts WHERE id = ?', [id]);
  if (!row) return null;
  const filePath = path.join(BASE_DIR, row.run_id, row.name);
  if (!fs.existsSync(filePath)) return null;
  const buf = fs.readFileSync(filePath);
  return { row, buf };
}

// Express handlers
function getRaw(req, res) {
  const { id } = req.params;
  const r = readFileById(id);
  if (!r) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', r.row.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(r.row.size || r.buf.length));
  res.setHeader('X-Artifact-Name', r.row.name || 'artifact');
  res.send(r.buf);
}

module.exports = { saveBuffer, getRaw };
