const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

function resolveSqlitePath() {
  const url = process.env.DB_URL || 'sqlite:///app/data/runner.db';
  if (url.startsWith('sqlite://')) {
    const file = url.replace(/^sqlite:\/\//, '').replace(/^file:/, '');
    return file.startsWith('/') ? file : path.join(process.cwd(), file);
  }
  return path.join(process.cwd(), 'data', 'runner.db');
}

const file = resolveSqlitePath();
const dir = path.dirname(file);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(file);
db.pragma('journal_mode = WAL');

function init() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  db.exec(sql);
}

function all(sql, params = []) { return db.prepare(sql).all(params); }
function one(sql, params = []) { return db.prepare(sql).get(params); }
function run(sql, params = []) { return db.prepare(sql).run(params); }
function txn(fn) { const t = db.transaction(fn); return t(); }

init();

module.exports = { db, all, one, run, txn };
