// API Routes for File Watcher
// Express routes for timeline, diffs, and restore operations

const express = require('express');
const router = express.Router();
const DiffGenerator = require('./diff-generator');
const fs = require('fs').promises;
const path = require('path');

class FileWatcherRoutes {
  constructor(database, fileWatcherService) {
    this.db = database;
    this.fileWatcher = fileWatcherService;
    this.diffGenerator = new DiffGenerator();
  }

  /**
   * Get timeline for a repository
   * GET /api/file-watcher/timeline/:connection/:repo
   * Query params: limit, search, source, startDate, endDate, batchesOnly
   */
  async getTimeline(req, res) {
    try {
      const { connection, repo } = req.params;
      const { 
        limit = 100, 
        search, 
        source, 
        startDate, 
        endDate,
        batchesOnly = false
      } = req.query;

      let sql;
      let params;

      if (batchesOnly === 'true') {
        // Get batches only
        sql = `
          SELECT 
            b.*,
            COUNT(s.id) as actual_file_count
          FROM file_snapshots_batches b
          LEFT JOIN file_snapshots s ON s.batch_id = b.id
          WHERE b.connection_id = ? AND b.repo_name = ?
        `;
        params = [connection, repo];

        // Add filters
        if (source) {
          sql += ` AND b.source_type = ?`;
          params.push(source);
        }
        if (startDate) {
          sql += ` AND b.created_at >= datetime(?)`;
          params.push(startDate);
        }
        if (endDate) {
          sql += ` AND b.created_at <= datetime(?)`;
          params.push(endDate);
        }

        sql += ` GROUP BY b.id ORDER BY b.created_at DESC LIMIT ?`;
        params.push(parseInt(limit));

      } else {
        // Get all snapshots with batch info
        sql = `
          SELECT 
            s.*,
            b.source_type as batch_source_type,
            b.source_operation as batch_source_operation,
            b.file_count as batch_file_count,
            b.created_at as batch_created_at
          FROM file_snapshots s
          LEFT JOIN file_snapshots_batches b ON s.batch_id = b.id
          WHERE s.connection_id = ? AND s.repo_name = ?
        `;
        params = [connection, repo];

        // Add search filter
        if (search) {
          sql += ` AND s.file_path LIKE ?`;
          params.push(`%${search}%`);
        }

        // Add source filter
        if (source) {
          sql += ` AND (s.source_type = ? OR b.source_type = ?)`;
          params.push(source, source);
        }

        // Add date filters
        if (startDate) {
          sql += ` AND s.created_at >= datetime(?)`;
          params.push(startDate);
        }
        if (endDate) {
          sql += ` AND s.created_at <= datetime(?)`;
          params.push(endDate);
        }

        sql += ` ORDER BY s.created_at DESC LIMIT ?`;
        params.push(parseInt(limit));
      }

      const rows = await this.query(sql, params);

      // Parse diff JSON
      const timeline = rows.map(row => {
        if (row.diff) {
          try {
            row.diff = JSON.parse(row.diff);
          } catch (e) {
            row.diff = null;
          }
        }
        return row;
      });

      res.json({
        success: true,
        timeline,
        count: timeline.length
      });

    } catch (error) {
      console.error('Error getting timeline:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get batch details with all files
   * GET /api/file-watcher/batch/:connection/:repo/:batchId
   */
  async getBatchDetails(req, res) {
    try {
      const { connection, repo, batchId } = req.params;

      // Get batch info
      const batchSql = `
        SELECT * FROM file_snapshots_batches
        WHERE id = ? AND connection_id = ? AND repo_name = ?
      `;
      const batch = await this.queryOne(batchSql, [batchId, connection, repo]);

      if (!batch) {
        return res.status(404).json({
          success: false,
          error: 'Batch not found'
        });
      }

      // Get all files in batch
      const filesSql = `
        SELECT * FROM file_snapshots
        WHERE batch_id = ?
        ORDER BY file_path
      `;
      const files = await this.query(filesSql, [batchId]);

      // Parse diff JSON
      files.forEach(file => {
        if (file.diff) {
          try {
            file.diff = JSON.parse(file.diff);
          } catch (e) {
            file.diff = null;
          }
        }
      });

      res.json({
        success: true,
        batch,
        files
      });

    } catch (error) {
      console.error('Error getting batch details:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get file history
   * GET /api/file-watcher/file-history/:connection/:repo/*
   */
  async getFileHistory(req, res) {
    try {
      const { connection, repo } = req.params;
      const filePath = req.params[0]; // Capture rest of path
      const { limit = 50 } = req.query;

      const sql = `
        SELECT 
          s.*,
          b.source_type as batch_source_type,
          b.source_operation as batch_source_operation
        FROM file_snapshots s
        LEFT JOIN file_snapshots_batches b ON s.batch_id = b.id
        WHERE s.connection_id = ? AND s.repo_name = ? AND s.file_path = ?
        ORDER BY s.created_at DESC
        LIMIT ?
      `;

      const rows = await this.query(sql, [connection, repo, filePath, parseInt(limit)]);

      // Parse diff JSON
      const history = rows.map(row => {
        if (row.diff) {
          try {
            row.diff = JSON.parse(row.diff);
          } catch (e) {
            row.diff = null;
          }
        }
        return row;
      });

      res.json({
        success: true,
        file_path: filePath,
        history,
        count: history.length
      });

    } catch (error) {
      console.error('Error getting file history:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get snapshot details
   * GET /api/file-watcher/snapshot/:connection/:repo/:id
   */
  async getSnapshot(req, res) {
    try {
      const { connection, repo, id } = req.params;

      const sql = `
        SELECT 
          s.*,
          b.source_type as batch_source_type,
          b.source_operation as batch_source_operation,
          b.file_count as batch_file_count
        FROM file_snapshots s
        LEFT JOIN file_snapshots_batches b ON s.batch_id = b.id
        WHERE s.id = ? AND s.connection_id = ? AND s.repo_name = ?
      `;

      const snapshot = await this.queryOne(sql, [id, connection, repo]);

      if (!snapshot) {
        return res.status(404).json({
          success: false,
          error: 'Snapshot not found'
        });
      }

      // Parse diff JSON
      if (snapshot.diff) {
        try {
          snapshot.diff = JSON.parse(snapshot.diff);
        } catch (e) {
          snapshot.diff = null;
        }
      }

      res.json({
        success: true,
        snapshot
      });

    } catch (error) {
      console.error('Error getting snapshot:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Get diff between snapshots
   * GET /api/file-watcher/diff/:connection/:repo
   * Query params: file_path, from_snapshot, to_snapshot, mode (unified/split/inline)
   */
  async getDiff(req, res) {
    try {
      const { connection, repo } = req.params;
      const { file_path, from_snapshot, to_snapshot, mode = 'unified' } = req.query;

      if (!file_path) {
        return res.status(400).json({
          success: false,
          error: 'file_path is required'
        });
      }

      // Get snapshots
      const fromSnap = from_snapshot ? 
        await this.getSnapshotById(from_snapshot, connection, repo) : 
        null;
      
      const toSnap = to_snapshot ? 
        await this.getSnapshotById(to_snapshot, connection, repo) : 
        await this.getLatestSnapshot(connection, repo, file_path);

      if (!toSnap) {
        return res.status(404).json({
          success: false,
          error: 'Snapshot not found'
        });
      }

      const oldContent = fromSnap ? fromSnap.content : '';
      const newContent = toSnap.content || '';

      let diff;
      if (mode === 'split') {
        diff = this.diffGenerator.generateSplitDiff(oldContent, newContent);
      } else if (mode === 'inline') {
        diff = this.diffGenerator.generateInlineDiff(oldContent, newContent);
      } else {
        // Unified diff
        diff = this.diffGenerator.generate(oldContent, newContent, file_path);
      }

      res.json({
        success: true,
        diff,
        mode,
        from_snapshot: fromSnap ? fromSnap.id : null,
        to_snapshot: toSnap.id,
        file_path
      });

    } catch (error) {
      console.error('Error getting diff:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Restore file to a snapshot version
   * POST /api/file-watcher/restore/:connection/:repo/:id
   * Body: { confirm: true }
   */
  async restoreFile(req, res) {
    try {
      const { connection, repo, id } = req.params;
      const { confirm } = req.body;

      if (!confirm) {
        return res.status(400).json({
          success: false,
          error: 'Confirmation required'
        });
      }

      // Get snapshot
      const snapshot = await this.getSnapshotById(id, connection, repo);
      if (!snapshot) {
        return res.status(404).json({
          success: false,
          error: 'Snapshot not found'
        });
      }

      // Get repository path
      // NOTE: You'll need to implement getRepoPath based on your system
      const repoPath = await this.getRepoPath(connection, repo);
      if (!repoPath) {
        return res.status(404).json({
          success: false,
          error: 'Repository not found'
        });
      }

      const fullPath = path.join(repoPath, snapshot.file_path);

      // Restore file
      if (snapshot.change_type === 'deleted') {
        // File was deleted in this snapshot, so delete it again
        try {
          await fs.unlink(fullPath);
        } catch (e) {
          // File might already be deleted
        }
      } else {
        // Restore content
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, snapshot.content || '', 'utf-8');
      }

      res.json({
        success: true,
        message: 'File restored successfully',
        file_path: snapshot.file_path,
        snapshot_id: id
      });

    } catch (error) {
      console.error('Error restoring file:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Search timeline
   * GET /api/file-watcher/search/:connection/:repo
   * Query params: query, limit
   */
  async searchTimeline(req, res) {
    try {
      const { connection, repo } = req.params;
      const { query, limit = 50 } = req.query;

      if (!query) {
        return res.status(400).json({
          success: false,
          error: 'Search query is required'
        });
      }

      const sql = `
        SELECT 
          s.*,
          b.source_type as batch_source_type,
          b.source_operation as batch_source_operation
        FROM file_snapshots_search fts
        JOIN file_snapshots s ON s.id = fts.snapshot_id
        LEFT JOIN file_snapshots_batches b ON s.batch_id = b.id
        WHERE fts.file_snapshots_search MATCH ?
          AND fts.connection_id = ?
          AND fts.repo_name = ?
        ORDER BY s.created_at DESC
        LIMIT ?
      `;

      const rows = await this.query(sql, [query, connection, repo, parseInt(limit)]);

      // Parse diff JSON
      const results = rows.map(row => {
        if (row.diff) {
          try {
            row.diff = JSON.parse(row.diff);
          } catch (e) {
            row.diff = null;
          }
        }
        return row;
      });

      res.json({
        success: true,
        results,
        count: results.length,
        query
      });

    } catch (error) {
      console.error('Error searching timeline:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  /**
   * Clear timeline
   * DELETE /api/file-watcher/timeline/:connection/:repo
   */
  async clearTimeline(req, res) {
    try {
      const { connection, repo } = req.params;
      const { confirm } = req.body;

      if (!confirm) {
        return res.status(400).json({
          success: false,
          error: 'Confirmation required'
        });
      }

      // Delete snapshots (cascades to search index)
      await this.execute(`
        DELETE FROM file_snapshots
        WHERE connection_id = ? AND repo_name = ?
      `, [connection, repo]);

      // Delete batches
      await this.execute(`
        DELETE FROM file_snapshots_batches
        WHERE connection_id = ? AND repo_name = ?
      `, [connection, repo]);

      res.json({
        success: true,
        message: 'Timeline cleared successfully'
      });

    } catch (error) {
      console.error('Error clearing timeline:', error);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }

  // Helper methods

  query(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  queryOne(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  execute(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  async getSnapshotById(id, connection, repo) {
    return this.queryOne(`
      SELECT * FROM file_snapshots
      WHERE id = ? AND connection_id = ? AND repo_name = ?
    `, [id, connection, repo]);
  }

  async getLatestSnapshot(connection, repo, file_path) {
    return this.queryOne(`
      SELECT * FROM file_snapshots
      WHERE connection_id = ? AND repo_name = ? AND file_path = ?
      ORDER BY created_at DESC
      LIMIT 1
    `, [connection, repo, file_path]);
  }

  async getRepoPath(connection, repo) {
    // TODO: Implement based on your system
    // This should return the filesystem path to the repository
    return `/workspace/repos/${connection}/${repo}`;
  }
}

// Export router setup function
module.exports = (database, fileWatcherService) => {
  const routes = new FileWatcherRoutes(database, fileWatcherService);
  
  router.get('/timeline/:connection/:repo', (req, res) => routes.getTimeline(req, res));
  router.get('/batch/:connection/:repo/:batchId', (req, res) => routes.getBatchDetails(req, res));
  router.get('/file-history/:connection/:repo/*', (req, res) => routes.getFileHistory(req, res));
  router.get('/snapshot/:connection/:repo/:id', (req, res) => routes.getSnapshot(req, res));
  router.get('/diff/:connection/:repo', (req, res) => routes.getDiff(req, res));
  router.post('/restore/:connection/:repo/:id', (req, res) => routes.restoreFile(req, res));
  router.get('/search/:connection/:repo', (req, res) => routes.searchTimeline(req, res));
  router.delete('/timeline/:connection/:repo', (req, res) => routes.clearTimeline(req, res));

  return router;
};