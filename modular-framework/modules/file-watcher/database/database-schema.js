// Database Schema for File Snapshots
// Run this to create the necessary tables

const createSchema = (db) => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Table for batch snapshots
      db.run(`
        CREATE TABLE IF NOT EXISTS file_snapshots_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          connection_id TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          source_type TEXT,
          source_operation TEXT,
          file_count INTEGER DEFAULT 1,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `, (err) => {
        if (err) {
          console.error('Error creating file_snapshots_batches table:', err);
        }
      });

      // Table for individual file snapshots
      // REMOVED the inline INDEX definitions - they're not valid in SQLite
      db.run(`
        CREATE TABLE IF NOT EXISTS file_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          connection_id TEXT NOT NULL,
          repo_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          content TEXT,
          diff TEXT,
          change_type TEXT,
          batch_id INTEGER,
          source_type TEXT,
          source_operation TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          
          FOREIGN KEY (batch_id) REFERENCES file_snapshots_batches(id) ON DELETE CASCADE
        )
      `, (err) => {
        if (err) {
          console.error('Error creating file_snapshots table:', err);
        }
      });

      // Create indexes as separate statements
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_snapshot_connection_repo 
        ON file_snapshots(connection_id, repo_name)
      `, (err) => {
        if (err) console.error('Error creating idx_snapshot_connection_repo:', err);
      });

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_snapshot_file 
        ON file_snapshots(connection_id, repo_name, file_path)
      `, (err) => {
        if (err) console.error('Error creating idx_snapshot_file:', err);
      });

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_snapshot_created 
        ON file_snapshots(created_at)
      `, (err) => {
        if (err) console.error('Error creating idx_snapshot_created:', err);
      });

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_snapshot_batch 
        ON file_snapshots(batch_id)
      `, (err) => {
        if (err) console.error('Error creating idx_snapshot_batch:', err);
      });

      // Search index for timeline
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS file_snapshots_search 
        USING fts5(
          file_path,
          content,
          connection_id UNINDEXED,
          repo_name UNINDEXED,
          snapshot_id UNINDEXED
        )
      `, (err) => {
        if (err) {
          console.error('Error creating search index:', err);
        }
      });

      // Trigger to update search index on insert
      db.run(`
        CREATE TRIGGER IF NOT EXISTS snapshot_search_insert 
        AFTER INSERT ON file_snapshots
        BEGIN
          INSERT INTO file_snapshots_search (file_path, content, connection_id, repo_name, snapshot_id)
          VALUES (NEW.file_path, NEW.content, NEW.connection_id, NEW.repo_name, NEW.id);
        END
      `, (err) => {
        if (err) {
          console.error('Error creating search trigger:', err);
        }
      });

      // Trigger to update search index on delete
      db.run(`
        CREATE TRIGGER IF NOT EXISTS snapshot_search_delete 
        AFTER DELETE ON file_snapshots
        BEGIN
          DELETE FROM file_snapshots_search WHERE snapshot_id = OLD.id;
        END
      `, (err) => {
        if (err) {
          console.error('Error creating delete trigger:', err);
        } else {
          resolve();
        }
      });
    });
  });
};

// Helper function to add indexes if they don't exist
const createIndexes = (db) => {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Additional composite indexes for better query performance
      db.run(`
        CREATE INDEX IF NOT EXISTS idx_snapshot_timeline 
        ON file_snapshots(connection_id, repo_name, created_at DESC)
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_snapshot_file_timeline 
        ON file_snapshots(connection_id, repo_name, file_path, created_at DESC)
      `);

      db.run(`
        CREATE INDEX IF NOT EXISTS idx_batch_timeline 
        ON file_snapshots_batches(connection_id, repo_name, created_at DESC)
      `, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
};

module.exports = {
  createSchema,
  createIndexes
};