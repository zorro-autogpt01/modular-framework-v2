const chokidar = require('chokidar');
const path = require('path');
const fs = require('fs').promises;
const RedisService = require('./redis');
const WebSocketService = require('./websocket');

class FileWatcherService {
  constructor() {
    this.watchers = new Map();
    this.WORKSPACE_ROOT = '/workspace/repos';
  }

  initialize() {
    console.log('📁 Initializing file watcher service...');
    this.startWatchingWorkspace();
  }

  startWatchingWorkspace() {
    // Watch the entire workspace for high-level changes
    const workspaceWatcher = chokidar.watch(this.WORKSPACE_ROOT, {
      ignored: [
        /(^|[\/\\])\../, // Ignore dotfiles
        /node_modules/,
        /.git/,
        /\.log$/
      ],
      persistent: true,
      ignoreInitial: true,
      depth: 5,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    workspaceWatcher
      .on('add', (filePath) => this.handleFileAdded(filePath))
      .on('change', (filePath) => this.handleFileChanged(filePath))
      .on('unlink', (filePath) => this.handleFileDeleted(filePath))
      .on('addDir', (dirPath) => this.handleDirAdded(dirPath))
      .on('unlinkDir', (dirPath) => this.handleDirDeleted(dirPath))
      .on('error', (error) => console.error('Watcher error:', error));

    this.watchers.set('workspace', workspaceWatcher);
  }

  watchRepository(connection_id, repo_name) {
    const watchKey = `${connection_id}:${repo_name}`;
    
    // Check if already watching
    if (this.watchers.has(watchKey)) {
      return;
    }

    const repoPath = path.join(this.WORKSPACE_ROOT, connection_id, repo_name);
    
    const watcher = chokidar.watch(repoPath, {
      ignored: [
        /(^|[\/\\])\../,
        /node_modules/,
        /.git/,
        /\.log$/
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 500,
        pollInterval: 100
      }
    });

    watcher
      .on('add', (filePath) => this.handleRepoFileEvent('add', connection_id, repo_name, filePath))
      .on('change', (filePath) => this.handleRepoFileEvent('change', connection_id, repo_name, filePath))
      .on('unlink', (filePath) => this.handleRepoFileEvent('unlink', connection_id, repo_name, filePath))
      .on('error', (error) => console.error(`Repo watcher error for ${watchKey}:`, error));

    this.watchers.set(watchKey, watcher);
    console.log(`👁️ Started watching repository: ${watchKey}`);
  }

  unwatchRepository(connection_id, repo_name) {
    const watchKey = `${connection_id}:${repo_name}`;
    const watcher = this.watchers.get(watchKey);
    
    if (watcher) {
      watcher.close();
      this.watchers.delete(watchKey);
      console.log(`🚫 Stopped watching repository: ${watchKey}`);
    }
  }

  async handleFileAdded(filePath) {
    const event = await this.createFileEvent('file:added', filePath);
    if (event) {
      await this.broadcastEvent(event);
    }
  }

  async handleFileChanged(filePath) {
    const event = await this.createFileEvent('file:changed', filePath);
    if (event) {
      await this.broadcastEvent(event);
      
      // Update file metadata in cache
      const stats = await fs.stat(filePath);
      const cacheKey = `file:meta:${event.connection_id}:${event.repo_name}:${event.file}`;
      await RedisService.set(cacheKey, JSON.stringify({
        size: stats.size,
        modified: stats.mtime,
        accessed: stats.atime
      }), 3600);
    }
  }

  async handleFileDeleted(filePath) {
    const event = await this.createFileEvent('file:deleted', filePath);
    if (event) {
      await this.broadcastEvent(event);
    }
  }

  async handleDirAdded(dirPath) {
    const event = await this.createFileEvent('dir:added', dirPath);
    if (event) {
      await this.broadcastEvent(event);
    }
  }

  async handleDirDeleted(dirPath) {
    const event = await this.createFileEvent('dir:deleted', dirPath);
    if (event) {
      await this.broadcastEvent(event);
    }
  }

  async handleRepoFileEvent(type, connection_id, repo_name, filePath) {
    const repoPath = path.join(this.WORKSPACE_ROOT, connection_id, repo_name);
    const relativePath = path.relative(repoPath, filePath);
    
    const event = {
      type: `repo:${type}`,
      connection_id,
      repo_name,
      file: relativePath,
      timestamp: new Date().toISOString()
    };

    // Add file stats if file exists
    if (type !== 'unlink') {
      try {
        const stats = await fs.stat(filePath);
        event.stats = {
          size: stats.size,
          modified: stats.mtime,
          isDirectory: stats.isDirectory()
        };
      } catch {
        // File might have been deleted by the time we check
      }
    }

    await this.broadcastEvent(event);
  }

  async createFileEvent(type, filePath) {
    // Parse the path to extract connection_id, repo_name, and file path
    const relativePath = path.relative(this.WORKSPACE_ROOT, filePath);
    const parts = relativePath.split(path.sep);
    
    if (parts.length < 3) {
      return null; // Not a repo file
    }

    const connection_id = parts[0];
    const repo_name = parts[1];
    const file = parts.slice(2).join(path.sep);

    const event = {
      type,
      connection_id,
      repo_name,
      file,
      timestamp: new Date().toISOString()
    };

    // Add file stats if file exists
    if (type !== 'file:deleted' && type !== 'dir:deleted') {
      try {
        const stats = await fs.stat(filePath);
        event.stats = {
          size: stats.size,
          modified: stats.mtime,
          isDirectory: stats.isDirectory()
        };
      } catch {
        // File might have been deleted by the time we check
      }
    }

    return event;
  }

  async broadcastEvent(event) {
    // Broadcast via WebSocket
    WebSocketService.broadcast({
      type: 'file:event',
      data: event
    });

    // Publish to Redis for other services
    await RedisService.publish('file:changes', JSON.stringify(event));

    // Log significant events
    if (event.type.includes('deleted') || event.type.includes('added')) {
      console.log(`📝 File event: ${event.type} - ${event.connection_id}/${event.repo_name}/${event.file}`);
    }
  }

  getWatcherStats() {
    const stats = {
      totalWatchers: this.watchers.size,
      watchers: []
    };

    this.watchers.forEach((watcher, key) => {
      stats.watchers.push({
        key,
        watched: watcher.getWatched()
      });
    });

    return stats;
  }

  async cleanup() {
    console.log('🧹 Cleaning up file watchers...');
    for (const [key, watcher] of this.watchers) {
      await watcher.close();
    }
    this.watchers.clear();
  }
}

module.exports = new FileWatcherService();
