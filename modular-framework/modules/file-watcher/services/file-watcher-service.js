// File Watcher Service
// Monitors filesystem changes using chokidar and creates snapshots

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs').promises;
const minimatchModule = require('minimatch');
const minimatch = minimatchModule.minimatch || minimatchModule;
const config = require('./file-watcher-config');
const DiffGenerator = require('./diff-generator');
const SourceDetector = require('./source-detector');

class FileWatcherService {
  constructor(database, websocketService = null) {
    this.db = database;
    this.ws = websocketService;
    this.watchers = new Map();
    this.pendingSnapshots = new Map();
    this.batchSnapshots = new Map();
    this.diffGenerator = new DiffGenerator();
    this.sourceDetector = new SourceDetector();
  }

  async startWatching(connection_id, repo_name, repo_path) {
    const key = `${connection_id}:${repo_name}`;
    
    if (this.watchers.has(key)) {
      console.log(`Already watching ${key}`);
      return;
    }

    console.log(`Starting file watcher for ${key} at ${repo_path}`);

    const watcher = chokidar.watch(repo_path, {
      persistent: true,
      ignoreInitial: true,
      ignored: this.buildIgnorePatterns(repo_path),
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100
      },
      depth: 99,
      followSymlinks: false
    });

    watcher.on('change', (filePath) => this.handleFileChange(connection_id, repo_name, repo_path, filePath, 'modified'));
    watcher.on('add', (filePath) => this.handleFileChange(connection_id, repo_name, repo_path, filePath, 'created'));
    watcher.on('unlink', (filePath) => this.handleFileChange(connection_id, repo_name, repo_path, filePath, 'deleted'));

    watcher.on('error', (error) => {
      console.error(`Watcher error for ${key}:`, error);
    });

    this.watchers.set(key, watcher);
    console.log(`File watcher started for ${key}`);
  }

  async stopWatching(connection_id, repo_name) {
    const key = `${connection_id}:${repo_name}`;
    const watcher = this.watchers.get(key);
    
    if (watcher) {
      await watcher.close();
      this.watchers.delete(key);
      this.clearPendingSnapshots(connection_id, repo_name);
      console.log(`Stopped watching ${key}`);
    }
  }

  buildIgnorePatterns(repoPath) {
    return (filePath) => {
      const relativePath = path.relative(repoPath, filePath);
      
      for (const pattern of config.ignorePatterns) {
        if (typeof minimatch === 'function' && minimatch(relativePath, pattern, { dot: true })) {
          return true;
        }
      }
      
      return false;
    };
  }

  async handleFileChange(connection_id, repo_name, repo_path, filePath, changeType) {
    try {
      const relativePath = path.relative(repo_path, filePath);
      
      if (changeType !== 'deleted') {
        const stats = await fs.stat(filePath);
        if (stats.size > config.maxFileSize) {
          console.log(`Skipping large file: ${relativePath} (${stats.size} bytes)`);
          return;
        }
        
        if (!config.includeBinaryFiles && await this.isBinaryFile(filePath)) {
          console.log(`Skipping binary file: ${relativePath}`);
          return;
        }
      }

      console.log(`File ${changeType}: ${relativePath}`);
      this.addToBatch(connection_id, repo_name, repo_path, relativePath, filePath, changeType);
      
    } catch (error) {
      console.error(`Error handling file change for ${filePath}:`, error);
    }
  }

  addToBatch(connection_id, repo_name, repo_path, relativePath, filePath, changeType) {
    const batchKey = `${connection_id}:${repo_name}`;
    
    let batch = this.batchSnapshots.get(batchKey);
    if (!batch) {
      batch = {
        files: [],
        repo_path: repo_path
      };
      this.batchSnapshots.set(batchKey, batch);
    }

    const existingIndex = batch.files.findIndex(f => f.relativePath === relativePath);
    if (existingIndex >= 0) {
      batch.files[existingIndex] = { relativePath, filePath, changeType };
    } else {
      batch.files.push({ relativePath, filePath, changeType });
    }

    if (batch.timeout) {
      clearTimeout(batch.timeout);
    }

    batch.timeout = setTimeout(() => {
      this.createBatchSnapshot(connection_id, repo_name, batch);
      this.batchSnapshots.delete(batchKey);
    }, config.debounceTime);
  }

  async createBatchSnapshot(connection_id, repo_name, batch) {
    try {
      console.log(`Creating batch snapshot for ${connection_id}:${repo_name} with ${batch.files.length} file(s)`);

      const source = await this.sourceDetector.detectSource(
        connection_id, 
        repo_name, 
        batch.repo_path,
        batch.files.map(f => f.relativePath)
      );

      const batchId = await this.createBatchRecord(connection_id, repo_name, source, batch.files.length);

      const snapshots = [];
      for (const file of batch.files) {
        const snapshot = await this.createFileSnapshot(
          connection_id, 
          repo_name, 
          batch.repo_path,
          file.relativePath,
          file.filePath, 
          file.changeType,
          batchId,
          source
        );
        if (snapshot) {
          snapshots.push(snapshot);
        }
      }

      await this.cleanupOldSnapshots(connection_id, repo_name);

      console.log(`Batch snapshot ${batchId} created successfully`);
      
      // Broadcast to WebSocket clients
      if (this.ws && snapshots.length > 0) {
        this.ws.broadcastBatch(connection_id, repo_name, {
          batch_id: batchId,
          snapshots: snapshots,
          source: source,
          created_at: new Date().toISOString()
        });
      }
      
    } catch (error) {
      console.error('Error creating batch snapshot:', error);
    }
  }

  async createBatchRecord(connection_id, repo_name, source, fileCount) {
    return new Promise((resolve, reject) => {
      const sql = `
        INSERT INTO file_snapshots_batches (connection_id, repo_name, source_type, source_operation, file_count, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `;
      
      this.db.run(sql, [
        connection_id,
        repo_name,
        source.type,
        source.operation,
        fileCount
      ], function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      });
    });
  }

  async createFileSnapshot(connection_id, repo_name, repo_path, relativePath, filePath, changeType, batchId, source) {
    try {
      let currentContent = '';
      if (changeType !== 'deleted') {
        currentContent = await fs.readFile(filePath, 'utf-8');
      }

      const previousSnapshot = await this.getLatestSnapshot(connection_id, repo_name, relativePath);

      const diff = this.diffGenerator.generate(
        previousSnapshot ? previousSnapshot.content : '',
        currentContent,
        relativePath
      );

      const snapshotId = await new Promise((resolve, reject) => {
        const sql = `
          INSERT INTO file_snapshots (
            connection_id, repo_name, file_path, content, diff, change_type,
            batch_id, source_type, source_operation, created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `;
        
        this.db.run(sql, [
          connection_id,
          repo_name,
          relativePath,
          currentContent,
          JSON.stringify(diff),
          changeType,
          batchId,
          source.type,
          source.operation
        ], function(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        });
      });

      return {
        id: snapshotId,
        connection_id,
        repo_name,
        file_path: relativePath,
        content: currentContent,
        diff: diff,
        change_type: changeType,
        batch_id: batchId,
        source_type: source.type,
        source_operation: source.operation,
        created_at: new Date().toISOString()
      };

    } catch (error) {
      console.error(`Error creating snapshot for ${relativePath}:`, error);
      return null;
    }
  }

  async getLatestSnapshot(connection_id, repo_name, file_path) {
    return new Promise((resolve, reject) => {
      const sql = `
        SELECT * FROM file_snapshots
        WHERE connection_id = ? AND repo_name = ? AND file_path = ?
        ORDER BY created_at DESC
        LIMIT 1
      `;
      
      this.db.get(sql, [connection_id, repo_name, file_path], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  async cleanupOldSnapshots(connection_id, repo_name) {
    try {
      const filesSql = `
        SELECT DISTINCT file_path FROM file_snapshots
        WHERE connection_id = ? AND repo_name = ?
      `;
      
      const files = await new Promise((resolve, reject) => {
        this.db.all(filesSql, [connection_id, repo_name], (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        });
      });

      for (const file of files) {
        await this.cleanupFileHistory(connection_id, repo_name, file.file_path);
      }

      await this.cleanupRepoHistory(connection_id, repo_name);

    } catch (error) {
      console.error('Error cleaning up old snapshots:', error);
    }
  }

  async cleanupFileHistory(connection_id, repo_name, file_path) {
    return new Promise((resolve, reject) => {
      const sql = `
        DELETE FROM file_snapshots
        WHERE id IN (
          SELECT id FROM file_snapshots
          WHERE connection_id = ? AND repo_name = ? AND file_path = ?
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
      `;
      
      this.db.run(sql, [connection_id, repo_name, file_path, config.maxFileHistory], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async cleanupRepoHistory(connection_id, repo_name) {
    return new Promise((resolve, reject) => {
      const sql = `
        DELETE FROM file_snapshots
        WHERE id IN (
          SELECT id FROM file_snapshots
          WHERE connection_id = ? AND repo_name = ?
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
      `;
      
      this.db.run(sql, [connection_id, repo_name, config.maxRepoHistory], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  clearPendingSnapshots(connection_id, repo_name) {
    const batchKey = `${connection_id}:${repo_name}`;
    const batch = this.batchSnapshots.get(batchKey);
    
    if (batch && batch.timeout) {
      clearTimeout(batch.timeout);
      this.batchSnapshots.delete(batchKey);
    }
  }

  async isBinaryFile(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      const chunk = buffer.slice(0, 8000);
      
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      return false;
    }
  }

  async stopAll() {
    for (const [key, watcher] of this.watchers.entries()) {
      await watcher.close();
      console.log(`Stopped watcher: ${key}`);
    }
    this.watchers.clear();
    this.batchSnapshots.clear();
  }
}

module.exports = FileWatcherService;