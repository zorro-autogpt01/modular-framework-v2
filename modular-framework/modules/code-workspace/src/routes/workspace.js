const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const WebSocketService = require('../services/websocket');
const SnapshotService = require('../services/snapshot');

const WORKSPACE_ROOT = '/workspace/repos';
const STAGING_ROOT = '/workspace/staging';


// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const stagingPath = path.join(STAGING_ROOT, uuidv4());
    await fs.mkdir(stagingPath, { recursive: true });
    cb(null, stagingPath);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Browse files in repository
router.get('/browse/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { path: filePath = '', depth = 1 } = req.query;

  try {
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    const targetPath = path.join(repoPath, filePath);

    // Security check - ensure we're still within repo
    if (!targetPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const items = await browseDirectory(targetPath, parseInt(depth));
    
    res.json({
      path: filePath || '/',
      items
    });
  } catch (error) {
    console.error('Error browsing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Read file content
router.get('/file/:connection_id/:repo_name/*', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const filePath = req.params[0];

  try {
    const fullPath = path.join(WORKSPACE_ROOT, connection_id, repo_name, filePath);
    
    // Security check
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    if (!fullPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const stats = await fs.stat(fullPath);
    
    if (stats.isDirectory()) {
      return res.status(400).json({ error: 'Path is a directory' });
    }

    // Check if binary
    const buffer = await fs.readFile(fullPath);
    const isBinary = isBufferBinary(buffer);

    if (isBinary) {
      res.json({
        path: filePath,
        binary: true,
        size: stats.size,
        encoding: 'base64',
        content: buffer.toString('base64')
      });
    } else {
      res.json({
        path: filePath,
        binary: false,
        size: stats.size,
        encoding: 'utf8',
        content: buffer.toString('utf8'),
        lines: buffer.toString('utf8').split('\n').length
      });
    }
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Write file content
router.put('/file/:connection_id/:repo_name/*', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const filePath = req.params[0];
  const { content, encoding = 'utf8', create_snapshot = true } = req.body;

  try {
    const fullPath = path.join(WORKSPACE_ROOT, connection_id, repo_name, filePath);
    
    // Security check
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    if (!fullPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create snapshot before modification
    if (create_snapshot) {
      await SnapshotService.createSnapshot(repoPath, 'file-edit', {
        edited_file: filePath
      });
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Write file
    if (encoding === 'base64') {
      await fs.writeFile(fullPath, Buffer.from(content, 'base64'));
    } else {
      await fs.writeFile(fullPath, content, encoding);
    }

    const stats = await fs.stat(fullPath);

    WebSocketService.broadcast({
      type: 'file:modified',
      data: {
        connection_id,
        repo_name,
        file: filePath,
        size: stats.size
      }
    });

    res.json({
      success: true,
      path: filePath,
      size: stats.size,
      message: 'File saved successfully'
    });
  } catch (error) {
    console.error('Error writing file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new file
router.post('/file/:connection_id/:repo_name/*', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const filePath = req.params[0];
  const { content = '', encoding = 'utf8' } = req.body;

  try {
    const fullPath = path.join(WORKSPACE_ROOT, connection_id, repo_name, filePath);
    
    // Security check
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    if (!fullPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Check if already exists
    try {
      await fs.access(fullPath);
      return res.status(409).json({ error: 'File already exists' });
    } catch {
      // File doesn't exist, continue
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });

    // Create file
    if (encoding === 'base64') {
      await fs.writeFile(fullPath, Buffer.from(content, 'base64'));
    } else {
      await fs.writeFile(fullPath, content, encoding);
    }

    const stats = await fs.stat(fullPath);

    WebSocketService.broadcast({
      type: 'file:created',
      data: {
        connection_id,
        repo_name,
        file: filePath,
        size: stats.size
      }
    });

    res.json({
      success: true,
      path: filePath,
      size: stats.size,
      message: 'File created successfully'
    });
  } catch (error) {
    console.error('Error creating file:', error);
    res.status(500).json({ error: error.message });
  }
});

// Delete file or directory
router.delete('/file/:connection_id/:repo_name/*', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const filePath = req.params[0];

  try {
    const fullPath = path.join(WORKSPACE_ROOT, connection_id, repo_name, filePath);
    
    // Security check
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    if (!fullPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create snapshot before deletion
    await SnapshotService.createSnapshot(repoPath, 'file-delete', {
      deleted_file: filePath
    });

    const stats = await fs.stat(fullPath);
    
    if (stats.isDirectory()) {
      await fs.rm(fullPath, { recursive: true, force: true });
    } else {
      await fs.unlink(fullPath);
    }

    WebSocketService.broadcast({
      type: 'file:deleted',
      data: {
        connection_id,
        repo_name,
        file: filePath,
        was_directory: stats.isDirectory()
      }
    });

    res.json({
      success: true,
      message: `${stats.isDirectory() ? 'Directory' : 'File'} deleted successfully`
    });
  } catch (error) {
    console.error('Error deleting:', error);
    res.status(500).json({ error: error.message });
  }
});

// Rename/move file or directory
router.post('/rename/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { from, to } = req.body;

  if (!from || !to) {
    return res.status(400).json({ error: 'Both from and to paths are required' });
  }

  try {
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    const fromPath = path.join(repoPath, from);
    const toPath = path.join(repoPath, to);

    // Security check
    if (!fromPath.startsWith(repoPath) || !toPath.startsWith(repoPath)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Create snapshot before rename
    await SnapshotService.createSnapshot(repoPath, 'file-rename', {
      from_path: from,
      to_path: to
    });

    // Ensure destination directory exists
    await fs.mkdir(path.dirname(toPath), { recursive: true });

    // Rename/move
    await fs.rename(fromPath, toPath);

    WebSocketService.broadcast({
      type: 'file:renamed',
      data: {
        connection_id,
        repo_name,
        from,
        to
      }
    });

    res.json({
      success: true,
      message: 'Renamed successfully',
      from,
      to
    });
  } catch (error) {
    console.error('Error renaming:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload files
router.post('/upload/:connection_id/:repo_name',
  upload.array('files', 20),
  async (req, res) => {
    const { connection_id, repo_name } = req.params;
    const { target_path = '' } = req.body;

    try {
      const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
      const targetDir = path.join(repoPath, target_path);

      // Security check
      if (!targetDir.startsWith(repoPath)) {
        return res.status(403).json({ error: 'Access denied' });
      }

      // Ensure target directory exists
      await fs.mkdir(targetDir, { recursive: true });

      const uploaded = [];
      for (const file of req.files) {
        const destPath = path.join(targetDir, file.originalname);
        await fs.rename(file.path, destPath);
        uploaded.push({
          name: file.originalname,
          size: file.size,
          path: path.join(target_path, file.originalname)
        });
      }

      // Clean up staging directory
      if (req.files.length > 0) {
        const stagingDir = path.dirname(req.files[0].path);
        await fs.rm(stagingDir, { recursive: true, force: true });
      }

      WebSocketService.broadcast({
        type: 'files:uploaded',
        data: {
          connection_id,
          repo_name,
          files: uploaded
        }
      });

      res.json({
        success: true,
        uploaded,
        message: `Uploaded ${uploaded.length} file(s)`
      });
    } catch (error) {
      console.error('Error uploading files:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Search in files
router.post('/search/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { 
    query, 
    include = ['*'], 
    exclude = ['node_modules', '.git'],
    case_sensitive = false,
    regex = false,
    max_results = 100
  } = req.body;

  if (!query) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    const results = await searchInFiles(
      repoPath, 
      query, 
      { include, exclude, case_sensitive, regex, max_results }
    );

    res.json({
      query,
      results: results.slice(0, max_results),
      total: results.length,
      truncated: results.length > max_results
    });
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({ error: error.message });
  }
});

// Promote files from diff-executor staging to workspace
router.post('/promote-from-staging', async (req, res) => {
  try {
    const { repoId, connectionId, stagingPath, files, source, createSnapshot } = req.body;

    // Log entire incoming payload
    console.log('========================================');
    console.log('[promote-from-staging] incoming body:');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('========================================');

    if (!repoId || !connectionId || !stagingPath || !files) {
      console.error('[promote-from-staging] Missing required fields', {
        hasRepoId: !!repoId,
        hasConnectionId: !!connectionId,
        hasStagingPath: !!stagingPath,
        hasFiles: !!files && Array.isArray(files),
      });
      return res.status(400).json({ 
        error: 'Missing required fields' 
      });
    }

    const repoPath = path.join(WORKSPACE_ROOT, connectionId, repoId);
    console.log('[promote-from-staging] repoPath:', repoPath);
    console.log('[promote-from-staging] WORKSPACE_ROOT:', WORKSPACE_ROOT);

    // Check if repo exists
    let repoExists = false;
    try {
      const stats = await fs.stat(repoPath);
      repoExists = stats.isDirectory();
      console.log('[promote-from-staging] repo exists:', repoExists, 'stats:', stats);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.error('[promote-from-staging] repo does not exist:', repoPath);
      } else {
        console.error('[promote-from-staging] error stat repoPath:', repoPath, err);
      }
      repoExists = false;
    }

    if (!repoExists) {
      return res.status(404).json({ 
        error: 'Repository not found',
        repoPath
      });
    }

    // Create snapshot if requested
    let snapshotId = null;
    if (createSnapshot) {
      try {
        console.log('[promote-from-staging] creating snapshot for repoPath:', repoPath);
        snapshotId = await SnapshotService.createSnapshot(
          repoPath,
          'diff-executor-promotion',
          {
            reason: `Before diff-executor promotion from job ${source?.jobId}`,
            source: 'diff-executor'
          }
        );
        console.log('[promote-from-staging] snapshot created:', snapshotId);
      } catch (err) {
        console.error('[promote-from-staging] error creating snapshot:', err);
      }
    }

    const copiedFiles = [];

    for (const file of files) {
      // Reconstruct the same layout diff-executor uses:
      // STAGING_DIR/jobId/connectionId/repoId/filePath
      const stagingFile = path.join(stagingPath, connectionId, repoId, file.filePath);
      const targetFile  = path.join(repoPath, file.filePath);

      console.log('[promote-from-staging] processing file:', {
        filePath: file.filePath,
        stagingPath,
        stagingFile,
        targetFile
      });

      let stagingExists = false;
      try {
        const s = await fs.stat(stagingFile);
        stagingExists = s.isFile();
        console.log('[promote-from-staging] staging file exists:', stagingFile);
      } catch (err) {
        if (err.code === 'ENOENT') {
          console.warn('[promote-from-staging] staging file not found:', stagingFile);
        } else {
          console.error('[promote-from-staging] error stat stagingFile:', stagingFile, err);
        }
        stagingExists = false;
      }

      if (!stagingExists) continue;

      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.copyFile(stagingFile, targetFile);
      console.log('[promote-from-staging] copied file', { from: stagingFile, to: targetFile });
      copiedFiles.push(file.filePath);
    }

    if (copiedFiles.length === 0) {
      console.warn('[promote-from-staging] no files were copied from staging', {
        repoPath,
        stagingPath,
        requestedFiles: files.map(f => f.filePath)
      });
    } else {
      console.log('[promote-from-staging] copied files:', copiedFiles);
    }

    WebSocketService.broadcast({
      type: 'files:promoted',
      data: {
        connectionId,
        repoId,
        files: copiedFiles,
        source,
        snapshotId
      }
    });

    res.json({
      success: true,
      filesPromoted: copiedFiles.length,
      snapshotId,
      message: `Promoted ${copiedFiles.length} files from staging to ${repoId}`,
      copiedFiles
    });
  } catch (error) {
    console.error('Error promoting from staging:', error);
    res.status(500).json({ error: error.message });
  }
});



// Helper functions
async function browseDirectory(dirPath, depth = 1, currentDepth = 0) {
  if (currentDepth >= depth) return [];

  const items = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;

    const fullPath = path.join(dirPath, entry.name);
    const stats = await fs.stat(fullPath);

    const item = {
      name: entry.name,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: stats.size,
      modified: stats.mtime,
      created: stats.ctime
    };

    if (entry.isDirectory() && currentDepth + 1 < depth) {
      item.children = await browseDirectory(fullPath, depth, currentDepth + 1);
    }

    items.push(item);
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function isBufferBinary(buffer) {
  // Check for null bytes in first 8000 bytes
  const checkLength = Math.min(buffer.length, 8000);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

async function searchInFiles(dirPath, query, options) {
  const results = [];
  const searchRegex = options.regex 
    ? new RegExp(query, options.case_sensitive ? '' : 'i')
    : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options.case_sensitive ? '' : 'i');

  async function search(currentPath, relativePath = '') {
    const entries = await fs.readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      const relPath = path.join(relativePath, entry.name);

      // Check exclusions
      if (options.exclude.some(ex => relPath.includes(ex))) continue;

      if (entry.isDirectory()) {
        await search(fullPath, relPath);
      } else {
        // Check inclusions
        if (!options.include.includes('*') && 
            !options.include.some(inc => relPath.endsWith(inc))) continue;

        try {
          const content = await fs.readFile(fullPath, 'utf8');
          const lines = content.split('\n');
          
          for (let i = 0; i < lines.length; i++) {
            if (searchRegex.test(lines[i])) {
              results.push({
                file: relPath,
                line: i + 1,
                text: lines[i].trim(),
                match: lines[i].match(searchRegex)[0]
              });

              if (results.length >= options.max_results * 2) return;
            }
          }
        } catch {
          // Skip binary files or read errors
        }
      }
    }
  }

  await search(dirPath);
  return results;
}

module.exports = router;
