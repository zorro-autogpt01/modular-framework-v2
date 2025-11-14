const express = require('express');
const router = express.Router();
const simpleGit = require('simple-git');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const RedisService = require('../services/redis');
const WebSocketService = require('../services/websocket');
const GitHubService = require('../services/github');

const WORKSPACE_ROOT = '/workspace/repos';

// Get all cloned repositories
router.get('/', async (req, res) => {
  try {
    const connections = await fs.readdir(WORKSPACE_ROOT).catch(() => []);
    const repos = [];

    for (const connection of connections) {
      const connectionPath = path.join(WORKSPACE_ROOT, connection);
      const stat = await fs.stat(connectionPath);
      
      if (stat.isDirectory()) {
        const repoFolders = await fs.readdir(connectionPath);
        
        for (const repoFolder of repoFolders) {
          const repoPath = path.join(connectionPath, repoFolder);
          const repoStat = await fs.stat(repoPath);
          
          if (repoStat.isDirectory()) {
            const git = simpleGit(repoPath);
            
            try {
              const status = await git.status();
              const branch = await git.branch();
              const remotes = await git.getRemotes(true);
              
              repos.push({
                id: `${connection}/${repoFolder}`,
                connection_id: connection,
                name: repoFolder,
                path: repoPath,
                status: {
                  current: branch.current,
                  tracking: branch.tracking,
                  ahead: status.ahead,
                  behind: status.behind,
                  modified: status.modified,
                  staged: status.staged,
                  deleted: status.deleted,
                  created: status.created,
                  conflicted: status.conflicted,
                  isClean: status.isClean()
                },
                branches: branch.all,
                remotes: remotes.map(r => ({
                  name: r.name,
                  refs: r.refs
                })),
                lastSync: await RedisService.get(`repo:lastsync:${connection}:${repoFolder}`)
              });
            } catch (gitError) {
              console.error(`Error getting git status for ${repoPath}:`, gitError);
              repos.push({
                id: `${connection}/${repoFolder}`,
                connection_id: connection,
                name: repoFolder,
                path: repoPath,
                error: gitError.message
              });
            }
          }
        }
      }
    }

    res.json({ repos });
  } catch (error) {
    console.error('Error listing repos:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clone a new repository
router.post('/clone', async (req, res) => {
  const { connection_id, repo_url, repo_name, branch = 'main', depth = 0 } = req.body;

  if (!connection_id || !repo_url || !repo_name) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const connectionPath = path.join(WORKSPACE_ROOT, connection_id);
    await fs.mkdir(connectionPath, { recursive: true });
    
    const repoPath = path.join(connectionPath, repo_name.replace('/', '-'));
    
    // Check if already exists
    try {
      await fs.access(repoPath);
      return res.status(409).json({ error: 'Repository already cloned' });
    } catch (e) {
      // Directory doesn't exist, proceed with clone
    }

    // ✅ Get authenticated clone URL from GitHub Hub
    const authenticatedUrl = await GitHubService.getConnectionCredentials(connection_id);
    const cloneUrl = authenticatedUrl || repo_url; // Fallback to original URL if credentials fail
    
    console.log('Cloning from URL:', cloneUrl.replace(/:[^:@]+@/, ':***@')); // Log with hidden token
    
    const git = simpleGit();
    const cloneOptions = ['--recurse-submodules'];
    
    if (depth > 0) {
      cloneOptions.push(`--depth=${depth}`);
    }
    
    if (branch !== 'main' && branch !== 'master') {
      cloneOptions.push(`--branch=${branch}`);
    }

    // Clone with progress tracking
    const cloneId = uuidv4();
    WebSocketService.broadcast({
      type: 'clone:start',
      data: { cloneId, repo_name, connection_id }
    });

    await git.clone(cloneUrl, repoPath, cloneOptions);
    
    // Fetch all branches if not shallow clone
    if (depth === 0) {
      const repoGit = simpleGit(repoPath);
      await repoGit.fetch(['--all']);
    }

    // Store metadata
    await RedisService.set(
      `repo:metadata:${connection_id}:${repo_name}`,
      JSON.stringify({
        cloned_at: new Date().toISOString(),
        clone_url: repo_url,
        connection_id,
        default_branch: branch
      })
    );

    WebSocketService.broadcast({
      type: 'clone:complete',
      data: { cloneId, repo_name, connection_id, path: repoPath }
    });

    res.json({ 
      success: true, 
      path: repoPath,
      message: `Repository cloned successfully to ${repoPath}`
    });
  } catch (error) {
    console.error('Error cloning repo:', error);
    WebSocketService.broadcast({
      type: 'clone:error',
      data: { repo_name, error: error.message }
    });
    res.status(500).json({ error: error.message });
  }
});

// Delete a cloned repository
router.delete('/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;

  try {
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    
    // Check if exists
    await fs.access(repoPath);
    
    // Remove directory recursively
    await fs.rm(repoPath, { recursive: true, force: true });
    
    // Clean up metadata
    await RedisService.del(`repo:metadata:${connection_id}:${repo_name}`);
    await RedisService.del(`repo:lastsync:${connection_id}:${repo_name}`);

    WebSocketService.broadcast({
      type: 'repo:deleted',
      data: { connection_id, repo_name }
    });

    res.json({ success: true, message: 'Repository deleted successfully' });
  } catch (error) {
    console.error('Error deleting repo:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get repository status
router.get('/:connection_id/:repo_name/status', async (req, res) => {
  const { connection_id, repo_name } = req.params;

  try {
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    const status = await git.status();
    const branch = await git.branch();
    const log = await git.log(['--oneline', '-10']);
    
    res.json({
      cloned: true,
      local_path: repoPath,
      is_dirty: !status.isClean(),
      current_branch: branch.current,
      status: {
        ahead: status.ahead,
        behind: status.behind,
        modified: status.modified,
        staged: status.staged,
        deleted: status.deleted,
        created: status.created,
        conflicted: status.conflicted
      },
      recent_commits: log.all
    });
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.json({ cloned: false });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});


// Fetch latest changes from remote
router.post('/:connection_id/:repo_name/fetch', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { all = true } = req.body;

  try {
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    WebSocketService.broadcast({
      type: 'fetch:start',
      data: { connection_id, repo_name }
    });

    const fetchOptions = all ? ['--all', '--prune'] : [];
    await git.fetch(fetchOptions);
    
    await RedisService.set(
      `repo:lastsync:${connection_id}:${repo_name}`,
      new Date().toISOString()
    );

    WebSocketService.broadcast({
      type: 'fetch:complete',
      data: { connection_id, repo_name }
    });

    res.json({ success: true, message: 'Fetched latest changes' });
  } catch (error) {
    console.error('Error fetching:', error);
    WebSocketService.broadcast({
      type: 'fetch:error',
      data: { connection_id, repo_name, error: error.message }
    });
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
