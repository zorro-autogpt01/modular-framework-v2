const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const diff = require('diff');
const { v4: uuidv4 } = require('uuid');
const WebSocketService = require('../services/websocket');

const HISTORY_ROOT = '/workspace/history';
const MAX_SNAPSHOTS = parseInt(process.env.MAX_SNAPSHOTS_PER_REPO) || 250;
const RETENTION_DAYS = parseInt(process.env.SNAPSHOT_RETENTION_DAYS) || 30;

// Get snapshot history for a repository
router.get('/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { file, limit = 50, offset = 0 } = req.query;

  try {
    const historyPath = path.join(HISTORY_ROOT, connection_id, repo_name);
    
    // Check if history exists
    try {
      await fs.access(historyPath);
    } catch {
      return res.json({ snapshots: [], total: 0 });
    }

    // Read snapshot metadata
    const metadataPath = path.join(historyPath, '.metadata.json');
    let metadata = {};
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      metadata = JSON.parse(data);
    } catch {
      metadata = { snapshots: [] };
    }

    // Filter by file if specified
    let snapshots = metadata.snapshots || [];
    if (file) {
      snapshots = snapshots.filter(s => 
        s.files && s.files.includes(file)
      );
    }

    // Sort by timestamp (newest first)
    snapshots.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );

    // Apply pagination
    const total = snapshots.length;
    snapshots = snapshots.slice(
      parseInt(offset), 
      parseInt(offset) + parseInt(limit)
    );

    res.json({ snapshots, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (error) {
    console.error('Error getting history:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a snapshot
router.post('/:connection_id/:repo_name/snapshot', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { 
    type = 'manual',
    description = '',
    files = [],
    author = 'system',
    metadata = {}
  } = req.body;

  try {
    const repoPath = path.join('/workspace/repos', connection_id, repo_name);
    const historyPath = path.join(HISTORY_ROOT, connection_id, repo_name);
    
    // Create history directory
    await fs.mkdir(historyPath, { recursive: true });

    // Generate snapshot ID
    const snapshotId = uuidv4();
    const timestamp = new Date().toISOString();
    const snapshotDir = path.join(historyPath, snapshotId);
    
    await fs.mkdir(snapshotDir, { recursive: true });

    // Copy specified files or entire repo
    const copiedFiles = [];
    if (files.length > 0) {
      // Copy specific files
      for (const file of files) {
        const sourcePath = path.join(repoPath, file);
        const destPath = path.join(snapshotDir, file);
        
        // Create destination directory
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        
        // Copy file
        try {
          await fs.copyFile(sourcePath, destPath);
          copiedFiles.push(file);
        } catch (error) {
          console.warn(`Failed to copy ${file}:`, error.message);
        }
      }
    } else {
      // Copy entire repo (excluding .git and node_modules)
      await copyDirectory(repoPath, snapshotDir, ['.git', 'node_modules']);
      copiedFiles.push('*');
    }

    // Update metadata
    const metadataPath = path.join(historyPath, '.metadata.json');
    let allMetadata = {};
    try {
      const data = await fs.readFile(metadataPath, 'utf8');
      allMetadata = JSON.parse(data);
    } catch {
      allMetadata = { snapshots: [] };
    }

    // Add new snapshot
    const snapshotInfo = {
      id: snapshotId,
      timestamp,
      type,
      description,
      author,
      files: copiedFiles,
      metadata,
      size: await getDirectorySize(snapshotDir)
    };

    allMetadata.snapshots = allMetadata.snapshots || [];
    allMetadata.snapshots.push(snapshotInfo);

    // Enforce max snapshots limit
    if (allMetadata.snapshots.length > MAX_SNAPSHOTS) {
      // Remove oldest snapshots
      const toRemove = allMetadata.snapshots
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
        .slice(0, allMetadata.snapshots.length - MAX_SNAPSHOTS);
      
      for (const snapshot of toRemove) {
        const snapPath = path.join(historyPath, snapshot.id);
        await fs.rm(snapPath, { recursive: true, force: true });
      }

      allMetadata.snapshots = allMetadata.snapshots.filter(s => 
        !toRemove.find(r => r.id === s.id)
      );
    }

    // Enforce retention period
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
    
    const expiredSnapshots = allMetadata.snapshots.filter(s => 
      new Date(s.timestamp) < cutoffDate
    );

    for (const snapshot of expiredSnapshots) {
      const snapPath = path.join(historyPath, snapshot.id);
      await fs.rm(snapPath, { recursive: true, force: true });
    }

    allMetadata.snapshots = allMetadata.snapshots.filter(s => 
      new Date(s.timestamp) >= cutoffDate
    );

    // Save updated metadata
    await fs.writeFile(metadataPath, JSON.stringify(allMetadata, null, 2));

    // Broadcast snapshot created
    WebSocketService.broadcast({
      type: 'snapshot:created',
      data: {
        connection_id,
        repo_name,
        snapshot: snapshotInfo
      }
    });

    res.json({ 
      success: true, 
      snapshot: snapshotInfo,
      total_snapshots: allMetadata.snapshots.length
    });
  } catch (error) {
    console.error('Error creating snapshot:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get snapshot details
router.get('/:connection_id/:repo_name/snapshot/:snapshot_id', async (req, res) => {
  const { connection_id, repo_name, snapshot_id } = req.params;

  try {
    const historyPath = path.join(HISTORY_ROOT, connection_id, repo_name);
    const snapshotDir = path.join(historyPath, snapshot_id);
    const metadataPath = path.join(historyPath, '.metadata.json');

    // Get metadata
    const data = await fs.readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(data);
    
    const snapshotInfo = metadata.snapshots.find(s => s.id === snapshot_id);
    if (!snapshotInfo) {
      return res.status(404).json({ error: 'Snapshot not found' });
    }

    // List files in snapshot
    const files = await listFiles(snapshotDir);

    res.json({
      ...snapshotInfo,
      files: files
    });
  } catch (error) {
    console.error('Error getting snapshot:', error);
    res.status(500).json({ error: error.message });
  }
});

// Restore from snapshot
router.post('/:connection_id/:repo_name/snapshot/:snapshot_id/restore', async (req, res) => {
  const { connection_id, repo_name, snapshot_id } = req.params;
  const { files = [], overwrite = true } = req.body;

  try {
    const repoPath = path.join('/workspace/repos', connection_id, repo_name);
    const historyPath = path.join(HISTORY_ROOT, connection_id, repo_name);
    const snapshotDir = path.join(historyPath, snapshot_id);

    // Check if snapshot exists
    await fs.access(snapshotDir);

    // Create backup of current state before restore
    await createBackupSnapshot(connection_id, repo_name, 'pre-restore');

    // Restore files
    const restoredFiles = [];
    if (files.length > 0) {
      // Restore specific files
      for (const file of files) {
        const sourcePath = path.join(snapshotDir, file);
        const destPath = path.join(repoPath, file);
        
        try {
          // Create destination directory
          await fs.mkdir(path.dirname(destPath), { recursive: true });
          
          // Copy file
          await fs.copyFile(sourcePath, destPath);
          restoredFiles.push(file);
        } catch (error) {
          console.warn(`Failed to restore ${file}:`, error.message);
        }
      }
    } else {
      // Restore entire snapshot
      if (overwrite) {
        // Clear existing files (except .git)
        const items = await fs.readdir(repoPath);
        for (const item of items) {
          if (item !== '.git') {
            const itemPath = path.join(repoPath, item);
            await fs.rm(itemPath, { recursive: true, force: true });
          }
        }
      }

      // Copy from snapshot
      await copyDirectory(snapshotDir, repoPath, []);
      restoredFiles.push('*');
    }

    WebSocketService.broadcast({
      type: 'snapshot:restored',
      data: {
        connection_id,
        repo_name,
        snapshot_id,
        files: restoredFiles
      }
    });

    res.json({
      success: true,
      restored: restoredFiles,
      message: `Restored ${restoredFiles.length} file(s) from snapshot`
    });
  } catch (error) {
    console.error('Error restoring snapshot:', error);
    res.status(500).json({ error: error.message });
  }
});

// Compare snapshots
router.get('/:connection_id/:repo_name/compare', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { from, to, file } = req.query;

  if (!from || !to) {
    return res.status(400).json({ error: 'Both from and to snapshot IDs are required' });
  }

  try {
    const historyPath = path.join(HISTORY_ROOT, connection_id, repo_name);
    const fromDir = path.join(historyPath, from);
    const toDir = path.join(historyPath, to);

    // Check if snapshots exist
    await fs.access(fromDir);
    await fs.access(toDir);

    const differences = [];

    if (file) {
      // Compare specific file
      const fromFile = path.join(fromDir, file);
      const toFile = path.join(toDir, file);
      
      let fromContent = '';
      let toContent = '';
      
      try {
        fromContent = await fs.readFile(fromFile, 'utf8');
      } catch {
        fromContent = '';
      }
      
      try {
        toContent = await fs.readFile(toFile, 'utf8');
      } catch {
        toContent = '';
      }

      const patches = diff.createPatch(file, fromContent, toContent);
      differences.push({
        file,
        patch: patches,
        added: fromContent === '' && toContent !== '',
        deleted: fromContent !== '' && toContent === '',
        modified: fromContent !== toContent && fromContent !== '' && toContent !== ''
      });
    } else {
      // Compare all files
      const fromFiles = await listFiles(fromDir);
      const toFiles = await listFiles(toDir);
      const allFiles = new Set([...fromFiles, ...toFiles]);

      for (const filePath of allFiles) {
        const fromFile = path.join(fromDir, filePath);
        const toFile = path.join(toDir, filePath);
        
        let fromContent = '';
        let toContent = '';
        
        try {
          fromContent = await fs.readFile(fromFile, 'utf8');
        } catch {
          fromContent = null;
        }
        
        try {
          toContent = await fs.readFile(toFile, 'utf8');
        } catch {
          toContent = null;
        }

        if (fromContent !== toContent) {
          differences.push({
            file: filePath,
            added: fromContent === null && toContent !== null,
            deleted: fromContent !== null && toContent === null,
            modified: fromContent !== null && toContent !== null && fromContent !== toContent
          });
        }
      }
    }

    res.json({
      from,
      to,
      differences
    });
  } catch (error) {
    console.error('Error comparing snapshots:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete a snapshot
router.delete('/:connection_id/:repo_name/snapshot/:snapshot_id', async (req, res) => {
  const { connection_id, repo_name, snapshot_id } = req.params;

  try {
    const historyPath = path.join(HISTORY_ROOT, connection_id, repo_name);
    const snapshotDir = path.join(historyPath, snapshot_id);
    const metadataPath = path.join(historyPath, '.metadata.json');

    // Remove snapshot directory
    await fs.rm(snapshotDir, { recursive: true, force: true });

    // Update metadata
    const data = await fs.readFile(metadataPath, 'utf8');
    const metadata = JSON.parse(data);
    
    metadata.snapshots = metadata.snapshots.filter(s => s.id !== snapshot_id);
    
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    WebSocketService.broadcast({
      type: 'snapshot:deleted',
      data: {
        connection_id,
        repo_name,
        snapshot_id
      }
    });

    res.json({
      success: true,
      message: 'Snapshot deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting snapshot:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper functions
async function copyDirectory(src, dest, exclude = []) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    if (exclude.includes(entry.name)) continue;

    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath, exclude);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function listFiles(dir, basePath = '') {
  const files = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.join(basePath, entry.name);

    if (entry.isDirectory()) {
      const subFiles = await listFiles(fullPath, relativePath);
      files.push(...subFiles);
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

async function getDirectorySize(dir) {
  let size = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      size += await getDirectorySize(fullPath);
    } else {
      const stats = await fs.stat(fullPath);
      size += stats.size;
    }
  }

  return size;
}

async function createBackupSnapshot(connection_id, repo_name, type) {
  const repoPath = path.join('/workspace/repos', connection_id, repo_name);
  const historyPath = path.join(HISTORY_ROOT, connection_id, repo_name);
  const snapshotId = uuidv4();
  const snapshotDir = path.join(historyPath, snapshotId);

  await fs.mkdir(snapshotDir, { recursive: true });
  await copyDirectory(repoPath, snapshotDir, ['.git', 'node_modules']);

  const metadataPath = path.join(historyPath, '.metadata.json');
  let metadata = {};
  try {
    const data = await fs.readFile(metadataPath, 'utf8');
    metadata = JSON.parse(data);
  } catch {
    metadata = { snapshots: [] };
  }

  metadata.snapshots = metadata.snapshots || [];
  metadata.snapshots.push({
    id: snapshotId,
    timestamp: new Date().toISOString(),
    type,
    description: `Automatic backup: ${type}`,
    author: 'system',
    files: ['*']
  });

  await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
  
  return snapshotId;
}

module.exports = router;
