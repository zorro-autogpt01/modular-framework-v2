const express = require('express');
const router = express.Router();
const simpleGit = require('simple-git');
const path = require('path');
const diff = require('diff');
const fs = require('fs').promises;
const WebSocketService = require('../services/websocket');
const SnapshotService = require('../services/snapshot');
const AIService = require('../services/ai');

const WORKSPACE_ROOT = '/workspace/repos';

// Helper to get repo path
function getRepoPath(connection_id, repo_name) {
  return path.join(WORKSPACE_ROOT, connection_id, repo_name);
}

// Get file diff
router.get('/diff/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { file, staged = false } = req.query;

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    let diffResult;
    if (file) {
      diffResult = staged 
        ? await git.diff(['--cached', '--', file])
        : await git.diff(['--', file]);
    } else {
      diffResult = staged
        ? await git.diff(['--cached'])
        : await git.diff();
    }

    res.json({ 
      diff: diffResult,
      files: diffResult ? parseDiffFiles(diffResult) : []
    });
  } catch (error) {
    console.error('Error getting diff:', error);
    res.status(500).json({ error: error.message });
  }
});

// Stage files
router.post('/stage/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { files = ['.'] } = req.body;

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    await git.add(files);
    
    const status = await git.status();
    
    WebSocketService.broadcast({
      type: 'files:staged',
      data: { connection_id, repo_name, files, status }
    });

    res.json({ 
      success: true, 
      staged: status.staged,
      message: `Staged ${files.length} file(s)`
    });
  } catch (error) {
    console.error('Error staging files:', error);
    res.status(500).json({ error: error.message });
  }
});

// Unstage files
router.post('/unstage/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { files = [] } = req.body;

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    await git.reset(['HEAD', ...files]);
    
    const status = await git.status();
    
    WebSocketService.broadcast({
      type: 'files:unstaged',
      data: { connection_id, repo_name, files, status }
    });

    res.json({ 
      success: true, 
      staged: status.staged,
      message: `Unstaged ${files.length} file(s)`
    });
  } catch (error) {
    console.error('Error unstaging files:', error);
    res.status(500).json({ error: error.message });
  }
});

// Commit changes
router.post('/commit/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { 
    message, 
    description = '', 
    author_name, 
    author_email,
    amend = false,
    auto_stage = false,
    generate_message = false
  } = req.body;

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    // Auto-stage if requested
    if (auto_stage) {
      await git.add('.');
    }

    // Generate commit message with AI if requested
    let commitMessage = message;
    if (generate_message) {
      const diff = await git.diff(['--cached']);
      const status = await git.status();
      commitMessage = await AIService.generateCommitMessage(diff, status.staged);
    }

    if (!commitMessage) {
      return res.status(400).json({ error: 'Commit message is required' });
    }

    // Create snapshot before commit
    await SnapshotService.createSnapshot(repoPath, 'pre-commit', {
      commit_message: commitMessage
    });

    // Configure author if provided
    if (author_name && author_email) {
      await git.addConfig('user.name', author_name);
      await git.addConfig('user.email', author_email);
    }

    // Build commit options
    const commitOptions = [];
    if (amend) {
      commitOptions.push('--amend');
    }

    // Commit with message and description
    const fullMessage = description 
      ? `${commitMessage}\n\n${description}`
      : commitMessage;

    const result = await git.commit(fullMessage, undefined, commitOptions);
    
    WebSocketService.broadcast({
      type: 'commit:created',
      data: { 
        connection_id, 
        repo_name, 
        commit: result.commit,
        message: commitMessage
      }
    });

    res.json({ 
      success: true, 
      commit: result.commit,
      message: commitMessage,
      summary: result.summary
    });
  } catch (error) {
    console.error('Error committing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Pull changes from remote
router.post('/pull/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { 
    branch = null, 
    rebase = false,
    stash = false,
    preview = false 
  } = req.body;

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    // Preview mode - just fetch and show what would be pulled
    if (preview) {
      await git.fetch();
      const status = await git.status();
      const currentBranch = status.current;
      const log = await git.log([
        `HEAD..origin/${currentBranch}`,
        '--oneline'
      ]);
      
      return res.json({
        preview: true,
        behind: status.behind,
        commits: log.all,
        wouldPull: log.total > 0
      });
    }

    // Create snapshot before pull
    await SnapshotService.createSnapshot(repoPath, 'pre-pull');

    WebSocketService.broadcast({
      type: 'pull:start',
      data: { connection_id, repo_name }
    });

    // Stash local changes if requested
    let stashed = false;
    if (stash) {
      const status = await git.status();
      if (!status.isClean()) {
        await git.stash();
        stashed = true;
      }
    }

    // Pull changes
    const pullOptions = [];
    if (rebase) {
      pullOptions.push('--rebase');
    }
    if (branch) {
      pullOptions.push('origin', branch);
    }

    const result = await git.pull(pullOptions);
    
    // Pop stash if we stashed
    if (stashed) {
      await git.stash(['pop']);
    }

    // Generate summary if changes were pulled
    let summary = null;
    if (result.summary.changes > 0) {
      summary = await AIService.summarizePullChanges(result);
    }

    WebSocketService.broadcast({
      type: 'pull:complete',
      data: { 
        connection_id, 
        repo_name,
        changes: result.summary.changes,
        summary
      }
    });

    res.json({ 
      success: true, 
      result: result.summary,
      summary
    });
  } catch (error) {
    console.error('Error pulling:', error);
    WebSocketService.broadcast({
      type: 'pull:error',
      data: { connection_id, repo_name, error: error.message }
    });
    res.status(500).json({ error: error.message });
  }
});

// Push changes to remote
router.post('/push/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { 
    branch = null,
    force = false,
    set_upstream = false,
    preview = false,
    check_quality = true
  } = req.body;

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    // Preview mode - show what would be pushed
    if (preview) {
      const status = await git.status();
      const currentBranch = status.current;
      const log = await git.log([
        `origin/${currentBranch}..HEAD`,
        '--oneline'
      ]);
      
      // Quality check with AI if requested
      let qualityCheck = null;
      if (check_quality && log.total > 0) {
        const diff = await git.diff([`origin/${currentBranch}...HEAD`]);
        qualityCheck = await AIService.analyzeCodeQuality(diff);
      }
      
      return res.json({
        preview: true,
        ahead: status.ahead,
        commits: log.all,
        wouldPush: log.total > 0,
        qualityCheck
      });
    }

    WebSocketService.broadcast({
      type: 'push:start',
      data: { connection_id, repo_name }
    });

    // Build push options
    const pushOptions = [];
    if (force) {
      pushOptions.push('--force-with-lease');
    }
    if (set_upstream) {
      pushOptions.push('--set-upstream');
    }
    if (branch) {
      pushOptions.push('origin', branch);
    }

    const result = await git.push(pushOptions);
    
    WebSocketService.broadcast({
      type: 'push:complete',
      data: { connection_id, repo_name, result }
    });

    res.json({ 
      success: true, 
      result,
      message: 'Changes pushed successfully'
    });
  } catch (error) {
    console.error('Error pushing:', error);
    WebSocketService.broadcast({
      type: 'push:error',
      data: { connection_id, repo_name, error: error.message }
    });
    res.status(500).json({ error: error.message });
  }
});

// Branch operations
router.get('/branches/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    const branches = await git.branch(['-a', '-v']);
    
    res.json({
      current: branches.current,
      branches: branches.all.map(name => ({
        name,
        current: name === branches.current,
        remote: name.startsWith('remotes/'),
        tracking: branches.branches[name]?.tracking || null,
        commit: branches.branches[name]?.commit || null,
        label: branches.branches[name]?.label || null
      }))
    });
  } catch (error) {
    console.error('Error getting branches:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create new branch
router.post('/branches/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { name, from = 'HEAD', checkout = true, push = false } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Branch name is required' });
  }

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    // Create branch
    if (checkout) {
      await git.checkoutBranch(name, from);
    } else {
      await git.branch([name, from]);
    }

    // Push to remote if requested
    if (push) {
      await git.push(['--set-upstream', 'origin', name]);
    }

    WebSocketService.broadcast({
      type: 'branch:created',
      data: { connection_id, repo_name, branch: name }
    });

    res.json({ 
      success: true, 
      branch: name,
      message: `Branch ${name} created successfully`
    });
  } catch (error) {
    console.error('Error creating branch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Switch branch
router.post('/checkout/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { branch, create = false } = req.body;

  if (!branch) {
    return res.status(400).json({ error: 'Branch name is required' });
  }

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    if (create) {
      await git.checkoutBranch(branch, 'HEAD');
    } else {
      await git.checkout(branch);
    }

    WebSocketService.broadcast({
      type: 'branch:switched',
      data: { connection_id, repo_name, branch }
    });

    res.json({ 
      success: true, 
      branch,
      message: `Switched to branch ${branch}`
    });
  } catch (error) {
    console.error('Error switching branch:', error);
    res.status(500).json({ error: error.message });
  }
});

// Merge branches
router.post('/merge/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { from, into = null, preview = false, no_ff = false } = req.body;

  if (!from) {
    return res.status(400).json({ error: 'Source branch is required' });
  }

  try {
    const repoPath = getRepoPath(connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    // Switch to target branch if specified
    if (into) {
      await git.checkout(into);
    }

    // Preview mode - show what would be merged
    if (preview) {
      const current = await git.branch();
      const log = await git.log([
        `${current.current}..${from}`,
        '--oneline'
      ]);
      
      return res.json({
        preview: true,
        from,
        into: into || current.current,
        commits: log.all,
        wouldMerge: log.total > 0
      });
    }

    // Create snapshot before merge
    await SnapshotService.createSnapshot(repoPath, 'pre-merge', {
      from_branch: from,
      into_branch: into || 'current'
    });

    // Perform merge
    const mergeOptions = no_ff ? ['--no-ff'] : [];
    const result = await git.merge([from, ...mergeOptions]);
    
    WebSocketService.broadcast({
      type: 'branch:merged',
      data: { connection_id, repo_name, from, into, result }
    });

    res.json({ 
      success: true, 
      result,
      message: `Merged ${from} successfully`
    });
  } catch (error) {
    console.error('Error merging:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to parse diff into file list
function parseDiffFiles(diffText) {
  const files = [];
  const lines = diffText.split('\n');
  
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) {
        files.push({
          from: match[1],
          to: match[2],
          name: match[2]
        });
      }
    }
  }
  
  return files;
}

module.exports = router;
