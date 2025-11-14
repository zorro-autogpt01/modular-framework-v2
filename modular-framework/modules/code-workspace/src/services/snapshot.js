const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const RedisService = require('./redis');
const WebSocketService = require('./websocket');

class SnapshotService {
  constructor() {
    this.HISTORY_ROOT = '/workspace/history';
    this.WORKSPACE_ROOT = '/workspace/repos';
    this.MAX_SNAPSHOTS = parseInt(process.env.MAX_SNAPSHOTS_PER_REPO) || 250;
    this.RETENTION_DAYS = parseInt(process.env.SNAPSHOT_RETENTION_DAYS) || 30;
    this.autoSnapshotInterval = null;
  }

  async initialize() {
    console.log('📸 Initializing snapshot service...');
    
    // Ensure history directory exists
    await fs.mkdir(this.HISTORY_ROOT, { recursive: true });
    
    // Start periodic cleanup
    this.startPeriodicCleanup();
    
    // Load settings
    await this.loadSettings();
  }

  async loadSettings() {
    try {
      const settingsStr = await RedisService.get('settings');
      if (settingsStr) {
        const settings = JSON.parse(settingsStr);
        if (settings.snapshots) {
          this.MAX_SNAPSHOTS = settings.snapshots.maxPerRepo || this.MAX_SNAPSHOTS;
          this.RETENTION_DAYS = settings.snapshots.retentionDays || this.RETENTION_DAYS;
          
          if (settings.snapshots.autoSnapshot) {
            this.startAutoSnapshot(settings.snapshots.autoSnapshotInterval || 3600);
          }
        }
      }
    } catch (error) {
      console.error('Error loading snapshot settings:', error);
    }
  }

  startAutoSnapshot(intervalSeconds) {
    if (this.autoSnapshotInterval) {
      clearInterval(this.autoSnapshotInterval);
    }

    this.autoSnapshotInterval = setInterval(async () => {
      await this.createAutoSnapshots();
    }, intervalSeconds * 1000);

    console.log(`⏰ Auto-snapshot enabled (every ${intervalSeconds} seconds)`);
  }

  async createAutoSnapshots() {
    try {
      // Get all repositories
      const connections = await fs.readdir(this.WORKSPACE_ROOT).catch(() => []);
      
      for (const connection of connections) {
        const connectionPath = path.join(this.WORKSPACE_ROOT, connection);
        const stat = await fs.stat(connectionPath);
        
        if (stat.isDirectory()) {
          const repos = await fs.readdir(connectionPath);
          
          for (const repo of repos) {
            const repoPath = path.join(connectionPath, repo);
            const repoStat = await fs.stat(repoPath);
            
            if (repoStat.isDirectory()) {
              // Check if repo has changes
              const hasChanges = await this.checkForChanges(connection, repo);
              
              if (hasChanges) {
                await this.createSnapshot(repoPath, 'auto', {
                  description: 'Automatic periodic snapshot'
                });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Error creating auto snapshots:', error);
    }
  }

  async checkForChanges(connection_id, repo_name) {
    const lastSnapshotKey = `snapshot:last:${connection_id}:${repo_name}`;
    const lastSnapshot = await RedisService.get(lastSnapshotKey);
    
    if (!lastSnapshot) {
      return true; // No previous snapshot, create one
    }

    const lastTime = new Date(JSON.parse(lastSnapshot).timestamp);
    const timeSinceLastSnapshot = Date.now() - lastTime.getTime();
    
    // Create snapshot if more than 1 hour since last one
    return timeSinceLastSnapshot > 3600000;
  }

  async createSnapshot(repoPath, type = 'manual', metadata = {}) {
    try {
      const pathParts = repoPath.split(path.sep);
      const repo_name = pathParts[pathParts.length - 1];
      const connection_id = pathParts[pathParts.length - 2];
      
      const historyPath = path.join(this.HISTORY_ROOT, connection_id, repo_name);
      const snapshotId = uuidv4();
      const timestamp = new Date().toISOString();
      const snapshotDir = path.join(historyPath, snapshotId);
      
      // Create snapshot directory
      await fs.mkdir(snapshotDir, { recursive: true });
      
      // Copy files (excluding .git and node_modules)
      await this.copyDirectory(repoPath, snapshotDir, ['.git', 'node_modules', 'dist', 'build']);
      
      // Calculate snapshot size
      const size = await this.getDirectorySize(snapshotDir);
      
      // Create snapshot metadata
      const snapshotInfo = {
        id: snapshotId,
        timestamp,
        type,
        size,
        ...metadata
      };
      
      // Update metadata file
      await this.updateMetadata(historyPath, snapshotInfo);
      
      // Update last snapshot cache
      await RedisService.set(
        `snapshot:last:${connection_id}:${repo_name}`,
        JSON.stringify(snapshotInfo)
      );
      
      // Enforce limits
      await this.enforceSnapshotLimits(historyPath);
      
      // Broadcast event
      WebSocketService.broadcast({
        type: 'snapshot:created',
        data: {
          connection_id,
          repo_name,
          snapshot: snapshotInfo
        }
      });
      
      console.log(`📸 Snapshot created: ${connection_id}/${repo_name}/${snapshotId}`);
      
      return snapshotInfo;
    } catch (error) {
      console.error('Error creating snapshot:', error);
      throw error;
    }
  }

  async copyDirectory(src, dest, exclude = []) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
      if (exclude.includes(entry.name)) continue;

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.copyDirectory(srcPath, destPath, exclude);
      } else {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  async getDirectorySize(dir) {
    let size = 0;
    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        size += await this.getDirectorySize(fullPath);
      } else {
        const stats = await fs.stat(fullPath);
        size += stats.size;
      }
    }

    return size;
  }

  async updateMetadata(historyPath, snapshotInfo) {
    const metadataPath = path.join(historyPath, '.metadata.json');
    let metadata = {};
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(data);
    } catch {
      metadata = { snapshots: [] };
    }

    metadata.snapshots = metadata.snapshots || [];
    metadata.snapshots.push(snapshotInfo);
    
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  async enforceSnapshotLimits(historyPath) {
    const metadataPath = path.join(historyPath, '.metadata.json');
    let metadata = {};
    
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(data);
    } catch {
      return; // No metadata, nothing to enforce
    }

    if (!metadata.snapshots || metadata.snapshots.length === 0) {
      return;
    }

    // Sort by timestamp
    metadata.snapshots.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );

    const toRemove = [];

    // Enforce max count
    if (metadata.snapshots.length > this.MAX_SNAPSHOTS) {
      toRemove.push(...metadata.snapshots.slice(this.MAX_SNAPSHOTS));
    }

    // Enforce retention period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.RETENTION_DAYS);
    
    for (const snapshot of metadata.snapshots) {
      if (new Date(snapshot.timestamp) < cutoffDate && !toRemove.includes(snapshot)) {
        toRemove.push(snapshot);
      }
    }

    // Remove old snapshots
    for (const snapshot of toRemove) {
      const snapshotDir = path.join(historyPath, snapshot.id);
      await fs.rm(snapshotDir, { recursive: true, force: true });
      console.log(`🗑️ Removed old snapshot: ${snapshot.id}`);
    }

    // Update metadata
    metadata.snapshots = metadata.snapshots.filter(s => 
      !toRemove.find(r => r.id === s.id)
    );
    
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  }

  startPeriodicCleanup() {
    // Run cleanup every hour
    setInterval(async () => {
      await this.cleanupAllSnapshots();
    }, 3600000);
  }

  async cleanupAllSnapshots() {
    console.log('🧹 Running snapshot cleanup...');
    
    try {
      const connections = await fs.readdir(this.HISTORY_ROOT).catch(() => []);
      
      for (const connection of connections) {
        const connectionPath = path.join(this.HISTORY_ROOT, connection);
        const stat = await fs.stat(connectionPath);
        
        if (stat.isDirectory()) {
          const repos = await fs.readdir(connectionPath);
          
          for (const repo of repos) {
            const historyPath = path.join(connectionPath, repo);
            const repoStat = await fs.stat(historyPath);
            
            if (repoStat.isDirectory()) {
              await this.enforceSnapshotLimits(historyPath);
            }
          }
        }
      }
      
      console.log('✅ Snapshot cleanup completed');
    } catch (error) {
      console.error('Error during snapshot cleanup:', error);
    }
  }

  async getSnapshotStats() {
    const stats = {
      totalSnapshots: 0,
      totalSize: 0,
      byRepo: {}
    };

    try {
      const connections = await fs.readdir(this.HISTORY_ROOT).catch(() => []);
      
      for (const connection of connections) {
        const connectionPath = path.join(this.HISTORY_ROOT, connection);
        const stat = await fs.stat(connectionPath);
        
        if (stat.isDirectory()) {
          const repos = await fs.readdir(connectionPath);
          
          for (const repo of repos) {
            const historyPath = path.join(connectionPath, repo);
            const metadataPath = path.join(historyPath, '.metadata.json');
            
            try {
              const data = await fs.readFile(metadataPath, 'utf8');
              const metadata = JSON.parse(data);
              
              if (metadata.snapshots) {
                const repoKey = `${connection}/${repo}`;
                stats.byRepo[repoKey] = {
                  count: metadata.snapshots.length,
                  size: metadata.snapshots.reduce((sum, s) => sum + (s.size || 0), 0),
                  latest: metadata.snapshots[0]?.timestamp
                };
                
                stats.totalSnapshots += metadata.snapshots.length;
                stats.totalSize += stats.byRepo[repoKey].size;
              }
            } catch {
              // No metadata file
            }
          }
        }
      }
    } catch (error) {
      console.error('Error getting snapshot stats:', error);
    }

    return stats;
  }
}

module.exports = new SnapshotService();
