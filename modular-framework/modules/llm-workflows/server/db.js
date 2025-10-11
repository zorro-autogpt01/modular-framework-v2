// modular-framework/modules/llm-workflows/server/db.js
const Database = require('better-sqlite3');
const path = require('path');
const { logInfo, logError } = require('./logger');

const DB_PATH = path.join(process.env.DATA_DIR || './data', 'workflows.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    conversation_id TEXT,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    input_vars TEXT,
    outputs TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  
  CREATE TABLE IF NOT EXISTS run_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    msg TEXT,
    meta TEXT,
    step TEXT,
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
  );
  
  CREATE TABLE IF NOT EXISTS run_artifacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step TEXT,
    type TEXT NOT NULL,
    content TEXT,
    filename TEXT,
    cwd TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE
  );
  
  CREATE INDEX IF NOT EXISTS idx_runs_workflow ON workflow_runs(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_runs_status ON workflow_runs(status);
  CREATE INDEX IF NOT EXISTS idx_runs_started ON workflow_runs(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_logs_run ON run_logs(run_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_run ON run_artifacts(run_id);
`);

logInfo('database_initialized', { path: DB_PATH });

// Run operations
function saveRun(run) {
  try {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO workflow_runs 
      (id, workflow_id, conversation_id, status, started_at, finished_at, input_vars, outputs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      run.id,
      run.workflowId,
      run.conversationId || null,
      run.status,
      run.startedAt,
      run.finishedAt || null,
      JSON.stringify(run.inputVars || {}),
      JSON.stringify(run.outputByStep || {})
    );
  } catch (e) {
    logError('save_run_failed', { run_id: run.id, error: e.message });
    throw e;
  }
}

function saveRunLog(runId, log) {
  try {
    const stmt = db.prepare(`
      INSERT INTO run_logs (run_id, ts, level, msg, meta, step)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      runId, 
      log.ts, 
      log.level, 
      log.msg, 
      JSON.stringify(log.meta || {}),
      log.step || null
    );
  } catch (e) {
    logError('save_run_log_failed', { run_id: runId, error: e.message });
  }
}

function saveRunArtifact(runId, artifact) {
  try {
    const stmt = db.prepare(`
      INSERT INTO run_artifacts (run_id, step, type, content, filename, cwd)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      runId,
      artifact.step || null,
      artifact.type,
      artifact.content || null,
      artifact.filename || null,
      artifact.cwd || null
    );
  } catch (e) {
    logError('save_run_artifact_failed', { run_id: runId, error: e.message });
  }
}

function getRunHistory(workflowId = null, limit = 100) {
  try {
    let query = 'SELECT * FROM workflow_runs';
    const params = [];
    
    if (workflowId) {
      query += ' WHERE workflow_id = ?';
      params.push(workflowId);
    }
    
    query += ' ORDER BY started_at DESC LIMIT ?';
    params.push(Math.min(Number(limit), 1000));
    
    const stmt = db.prepare(query);
    const rows = stmt.all(...params);
    
    return rows.map(row => ({
      ...row,
      inputVars: JSON.parse(row.input_vars || '{}'),
      outputByStep: JSON.parse(row.outputs || '{}')
    }));
  } catch (e) {
    logError('get_run_history_failed', { workflow_id: workflowId, error: e.message });
    return [];
  }
}

function getRunById(runId) {
  try {
    const stmt = db.prepare('SELECT * FROM workflow_runs WHERE id = ?');
    const run = stmt.get(runId);
    
    if (!run) return null;
    
    const logsStmt = db.prepare('SELECT * FROM run_logs WHERE run_id = ? ORDER BY id ASC');
    const logs = logsStmt.all(runId).map(log => ({
      ...log,
      meta: JSON.parse(log.meta || '{}')
    }));
    
    const artifactsStmt = db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY id ASC');
    const artifacts = artifactsStmt.all(runId);
    
    return {
      ...run,
      inputVars: JSON.parse(run.input_vars || '{}'),
      outputByStep: JSON.parse(run.outputs || '{}'),
      logs,
      artifacts
    };
  } catch (e) {
    logError('get_run_by_id_failed', { run_id: runId, error: e.message });
    return null;
  }
}

function getWorkflowStats(workflowId, days = 30) {
  try {
    const stmt = db.prepare(`
      SELECT 
        COUNT(*) as total_runs,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as successful_runs,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_runs,
        AVG(
          CASE 
            WHEN finished_at IS NOT NULL 
            THEN (julianday(finished_at) - julianday(started_at)) * 86400
            ELSE NULL
          END
        ) as avg_duration_seconds,
        MIN(started_at) as first_run,
        MAX(started_at) as last_run
      FROM workflow_runs
      WHERE workflow_id = ?
        AND started_at > datetime('now', '-' || ? || ' days')
    `);
    
    return stmt.get(workflowId, days);
  } catch (e) {
    logError('get_workflow_stats_failed', { workflow_id: workflowId, error: e.message });
    return null;
  }
}

function getWorkflowTimeline(workflowId, days = 30) {
  try {
    const stmt = db.prepare(`
      SELECT 
        date(started_at) as date,
        COUNT(*) as runs,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as successful
      FROM workflow_runs
      WHERE workflow_id = ?
        AND started_at > datetime('now', '-' || ? || ' days')
      GROUP BY date(started_at)
      ORDER BY date
    `);
    
    return stmt.all(workflowId, days);
  } catch (e) {
    logError('get_workflow_timeline_failed', { workflow_id: workflowId, error: e.message });
    return [];
  }
}

function cleanupOldRuns(daysToKeep = 90) {
  try {
    const stmt = db.prepare(`
      DELETE FROM workflow_runs
      WHERE started_at < datetime('now', '-' || ? || ' days')
    `);
    
    const info = stmt.run(daysToKeep);
    logInfo('cleanup_old_runs', { deleted: info.changes, days: daysToKeep });
    return info.changes;
  } catch (e) {
    logError('cleanup_old_runs_failed', { error: e.message });
    return 0;
  }
}

module.exports = {
  db,
  saveRun,
  saveRunLog,
  saveRunArtifact,
  getRunHistory,
  getRunById,
  getWorkflowStats,
  getWorkflowTimeline,
  cleanupOldRuns
};