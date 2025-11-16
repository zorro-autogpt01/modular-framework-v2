// File Watcher Service
// Monitors filesystem changes using chokidar and creates snapshots

const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs').promises;
const minimatch = require('minimatch');
const config = require('./file-watcher-config');
const DiffGenerator = require('./diff-generator');
const SourceDetector = require('./source-detector');

class FileWatcherService {
  constructor(database) {
    this.db = database;
    this.watchers = new Map(); // connection_id:repo_name -> watcher
    this.pendingSnapshots = new Map(); // connection_id:repo_name:file -> timeout
    this.batchSnapshots = new Map(); // connection_id:repo_name -> {files, timeout}
    this.diffGenerator = new DiffGenerator();
    this.sourceDetector = new SourceDetector();
  }

  /**
   * Start watching a repository
   */
  async startWatching(connection_id, repo_name, repo_path) {
    const key = `${connection_id}:${repo_name}`;
    
    // Don't start if already watching
    if (this.watchers.has(key)) {
      console.log(`Already watching ${key}`);
      return;
    }

    console.log(`Starting file watcher for ${key} at ${repo_path}`);

    // Create chokidar watcher
    const watcher = chokidar.watch(repo_path, {
      persistent: true,
      ignoreInitial: true, // Don't trigger on initial scan
      ignored: this.buildIgnorePatterns(repo_path),
      awaitWriteFinish: {
        stabilityThreshold: 1000, // Wait 1s for file to finish writing
        pollInterval: 100
      },
      depth: 99, // Deep recursion
      followSymlinks: false
    });

    // Handle file changes
    watcher.on('change', (filePath) => this.handleFileChange(connection_id, repo_name, repo_path, filePath, 'modified'));
    watcher.on('add', (filePath) => this.handleFileChange(connection_id, repo_name, repo_path, filePath, 'created'));
    watcher.on('unlink', (filePath) => this.handleFileChange(connection_id, repo_name, repo_path, filePath, 'deleted'));

    // Handle errors
    watcher.on('error', (error) => {
      console.error(`Watcher error for ${key}:`, error);
    });

    this.watchers.set(key, watcher);
    console.log(`File watcher started for ${key}`);
  }

  /**
   * Stop watching a repository
   */
  async stopWatching(connection_id, repo_name) {
    const key = `${connection_id}:${repo_name}`;
    const watcher = this.watchers.get(key);
    
    if (watcher) {
      await watcher.close();
      this.watchers.delete(key);
      
      // Clear any pending snapshots
      this.clearPendingSnapshots(connection_id, repo_name);
      
      console.log(`Stopped watching ${key}`);
    }
  }

  /**
   * Build ignore patterns for chokidar
   */
  buildIgnorePatterns(repoPath) {
    return (filePath) => {
      const relativePath = path.relative(repoPath, filePath);
      
      // Check against ignore patterns
      for (const pattern of config.ignorePatterns) {
        if (minimatch(relativePath, pattern, { dot: true })) {
          return true; // Ignore this file
        }
      }
      
      return false; // Don't ignore
    };
  }

  /**
   * Handle file change event
   */
  async handleFileChange(connection_id, repo_name, repo_path, filePath, changeType) {
    try {
      const relativePath = path.relative(repo_path, filePath);
      
      // Skip if file is too large
      if (changeType !== 'deleted') {
        const stats = await fs.stat(filePath);
        if (stats.size > config.maxFileSize) {
          console.log(`Skipping large file: ${relativePath} (${stats.size} bytes)`);
          return;
        }
        
        // Skip binary files if configured
        if (!config.includeBinaryFiles && await this.isBinaryFile(filePath)) {
          console.log(`Skipping binary file: ${relativePath}`);
          return;
        }
      }

      console.log(`File ${changeType}: ${relativePath}`);

      // Add to batch
      this.addToBatch(connection_id, repo_name, repo_path, relativePath, filePath, changeType);
      
    } catch (error) {
      console.error(`Error handling file change for ${filePath}:`, error);
    }
  }

  /**
   * Add file change to batch and schedule snapshot
   */
  addToBatch(connection_id, repo_name, repo_path, relativePath, filePath, changeType) {
    const batchKey = `${connection_id}:${repo_name}`;
    
    // Get or create batch
    let batch = this.batchSnapshots.get(batchKey);
    if (!batch) {
      batch = {
        files: [],
        repo_path: repo_path
      };
      this.batchSnapshots.set(batchKey, batch);
    }

    // Add file to batch (or update if already exists)
    const existingIndex = batch.files.findIndex(f => f.relativePath === relativePath);
    if (existingIndex >= 0) {
      batch.files[existingIndex] = { relativePath, filePath, changeType };
    } else {
      batch.files.push({ relativePath, filePath, changeType });
    }

    // Clear existing timeout
    if (batch.timeout) {
      clearTimeout(batch.timeout);
    }

    // Schedule batch snapshot after debounce time
    batch.timeout = setTimeout(() => {
      this.createBatchSnapshot(connection_id, repo_name, batch);
      this.batchSnapshots.delete(batchKey);
    }, config.debounceTime);
  }

  /**
   * Create a snapshot for batched file changes
   */
  async createBatchSnapshot(connection_id, repo_name, batch) {
    try {
      console.log(`Creating batch snapshot for ${connection_id}:${repo_name} with ${batch.files.length} file(s)`);

      // Detect source of changes
      const source = await this.sourceDetector.detectSource(
        connection_id, 
        repo_name, 
        batch.repo_path,
        batch.files.map(f => f.relativePath)
      );

      // Create batch snapshot record
      const batchId = await this.createBatchRecord(connection_id, repo_name, source, batch.files.length);

      // Create individual file snapshots
      for (const file of batch.files) {
        await this.createFileSnapshot(
          connection_id, 
          repo_name, 
          batch.repo_path,
          file.relativePath,
          file.filePath, 
          file.changeType,
          batchId,
          source
        );
      }

      // Cleanup old snapshots if needed
      await this.cleanupOldSnapshots(connection_id, repo_name);

      console.log(`Batch snapshot ${batchId} created successfully`);
      
    } catch (error) {
      console.error('Error creating batch snapshot:', error);
    }
  }

  /**
   * Create batch record in database
   */
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

  /**
   * Create individual file snapshot
   */
  async createFileSnapshot(connection_id, repo_name, repo_path, relativePath, filePath, changeType, batchId, source) {
    try {
      // Read current content (or empty for deleted files)
      let currentContent = '';
      if (changeType !== 'deleted') {
        currentContent = await fs.readFile(filePath, 'utf-8');
      }

      // Get previous snapshot
      const previousSnapshot = await this.getLatestSnapshot(connection_id, repo_name, relativePath);

      // Generate diff
      const diff = this.diffGenerator.generate(
        previousSnapshot ? previousSnapshot.content : '',
        currentContent,
        relativePath
      );

      // Insert snapshot
      return new Promise((resolve, reject) => {
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

    } catch (error) {
      console.error(`Error creating snapshot for ${relativePath}:`, error);
    }
  }

  /**
   * Get latest snapshot for a file
   */
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

  /**
   * Cleanup old snapshots based on limits
   */
  async cleanupOldSnapshots(connection_id, repo_name) {
    try {
      // Cleanup per-file history
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

      // Cleanup repository total history
      await this.cleanupRepoHistory(connection_id, repo_name);

    } catch (error) {
      console.error('Error cleaning up old snapshots:', error);
    }
  }

  /**
   * Cleanup old snapshots for a specific file
   */
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

  /**
   * Cleanup old snapshots for repository total
   */
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

  /**
   * Clear pending snapshots for a repository
   */
  clearPendingSnapshots(connection_id, repo_name) {
    const batchKey = `${connection_id}:${repo_name}`;
    const batch = this.batchSnapshots.get(batchKey);
    
    if (batch && batch.timeout) {
      clearTimeout(batch.timeout);
      this.batchSnapshots.delete(batchKey);
    }
  }

  /**
   * Check if file is binary
   */
  async isBinaryFile(filePath) {
    try {
      const buffer = await fs.readFile(filePath);
      const chunk = buffer.slice(0, 8000);
      
      // Check for null bytes (common in binary files)
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

  /**
   * Stop all watchers
   */
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