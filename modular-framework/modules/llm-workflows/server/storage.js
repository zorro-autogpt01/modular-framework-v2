const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'workflows.json');

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadAll() {
  ensureDir();
  if (!fs.existsSync(FILE)) return [];
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}
function saveAll(arr) {
  ensureDir();
  fs.writeFileSync(FILE, JSON.stringify(arr, null, 2));
}

function upsert(wf) {
  const arr = loadAll();
  const idx = arr.findIndex(x => x.id === wf.id);
  if (idx >= 0) arr[idx] = wf; else arr.push(wf);
  saveAll(arr); return wf;
}
function remove(id) {
  const arr = loadAll().filter(x => x.id !== id);
  saveAll(arr);
}
function get(id) {
  return loadAll().find(x => x.id === id);
}

module.exports = { loadAll, saveAll, upsert, remove, get };

