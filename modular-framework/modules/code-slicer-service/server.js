// modular-framework/modules/code-slicer-service/server.js
// Enhanced with GitHub branch support

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Configuration
const PORT = process.env.PORT || 3025;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, 'cache');
const GITHUB_HUB_URL = process.env.GITHUB_HUB_URL || 'http://github-hub-module:3005/api';
const LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010/api';
const POSTGRES_URL = process.env.POSTGRES_URL;

// Database connection (optional)
let pool = null;
if (POSTGRES_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: POSTGRES_URL });
}

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'slices'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'repos'), { recursive: true });
}

// ============= GitHub Hub Client with Branch Support =============
class GitHubHubClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  /**
   * Clone repository with optional branch support
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branch - Optional branch name (defaults to repo's default branch)
   * @param {string} connId - Optional connection ID
   * @returns {Promise<string>} Path to cloned repository
   */
  async cloneRepo(owner, repo, branch = null, connId = null) {
    try {
      const payload = {
        owner,
        repo,
        conn_id: connId
      };
      
      if (branch) {
        payload.branch = branch;
      }

      const response = await axios.post(`${this.baseUrl}/clone`, payload);
      
      if (response.data && response.data.path) {
        return response.data.path;
      }
      
      throw new Error('Clone response missing path');
    } catch (error) {
      console.error('Clone error:', error.response?.data || error.message);
      throw new Error(`Failed to clone ${owner}/${repo}${branch ? `@${branch}` : ''}: ${error.message}`);
    }
  }

  /**
   * List all branches for a repository
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} connId - Optional connection ID
   * @returns {Promise<Array>} List of branch names
   */
  async listBranches(owner, repo, connId = null) {
    try {
      const params = { owner, repo };
      if (connId) params.conn_id = connId;

      const response = await axios.get(`${this.baseUrl}/branches`, { params });
      
      if (response.data && Array.isArray(response.data.branches)) {
        return response.data.branches;
      }
      
      return response.data || [];
    } catch (error) {
      console.error('List branches error:', error.response?.data || error.message);
      throw new Error(`Failed to list branches for ${owner}/${repo}: ${error.message}`);
    }
  }

  /**
   * Get branch details including commit SHA
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} branch - Branch name
   * @param {string} connId - Optional connection ID
   * @returns {Promise<Object>} Branch details
   */
  async getBranchInfo(owner, repo, branch, connId = null) {
    try {
      const params = { owner, repo, branch };
      if (connId) params.conn_id = connId;

      const response = await axios.get(`${this.baseUrl}/branch-info`, { params });
      return response.data;
    } catch (error) {
      console.error('Get branch info error:', error.response?.data || error.message);
      throw new Error(`Failed to get info for branch ${branch}: ${error.message}`);
    }
  }

  /**
   * Compare two branches
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} base - Base branch name
   * @param {string} head - Head branch name
   * @param {string} connId - Optional connection ID
   * @returns {Promise<Object>} Comparison details
   */
  async compareBranches(owner, repo, base, head, connId = null) {
    try {
      const params = { owner, repo, base, head };
      if (connId) params.conn_id = connId;

      const response = await axios.post(`${this.baseUrl}/compare`, params);
      return response.data;
    } catch (error) {
      console.error('Compare branches error:', error.response?.data || error.message);
      throw new Error(`Failed to compare ${base}...${head}: ${error.message}`);
    }
  }

  async getPRFiles(owner, repo, prNumber, connId = null) {
    try {
      const params = { owner, repo, pr_number: prNumber };
      if (connId) params.conn_id = connId;

      const response = await axios.get(`${this.baseUrl}/pr-files`, { params });
      return response.data.files || [];
    } catch (error) {
      console.error('Get PR files error:', error.response?.data || error.message);
      throw new Error(`Failed to get PR files: ${error.message}`);
    }
  }

  async getIssue(owner, repo, issueNumber, connId = null) {
    try {
      const params = { owner, repo, issue_number: issueNumber };
      if (connId) params.conn_id = connId;

      const response = await axios.get(`${this.baseUrl}/issue`, { params });
      return response.data;
    } catch (error) {
      console.error('Get issue error:', error.response?.data || error.message);
      throw new Error(`Failed to get issue: ${error.message}`);
    }
  }
}

const githubHub = new GitHubHubClient(GITHUB_HUB_URL);

// ============= Code Slicer Wrapper =============
class CodeSlicerWrapper {
  constructor(scriptPath) {
    this.scriptPath = scriptPath || path.join(__dirname, 'scripts', 'api_code_slicer.py');
  }

  async analyze(options) {
    const {
      repoPath,
      targets = [],
      context = 10,
      hints = [],
      outputDir = null,
      promptPack = false,
      maxFiles = null
    } = options;

    const sliceId = outputDir ? path.basename(outputDir) : uuidv4();
    const actualOutputDir = outputDir || path.join(DATA_DIR, 'slices', sliceId);

    await fs.mkdir(actualOutputDir, { recursive: true });

    const args = [
      this.scriptPath,
      '--repo-path', repoPath,
      '--output-dir', actualOutputDir,
      '--context', context.toString()
    ];

    if (targets.length > 0) {
      args.push('--targets', ...targets);
    }

    if (hints.length > 0) {
      args.push('--hints', ...hints);
    }

    if (promptPack) {
      args.push('--prompt-pack');
    }

    if (maxFiles) {
      args.push('--max-files', maxFiles.toString());
    }

    return new Promise((resolve, reject) => {
      const process = spawn('python3', args, {
        cwd: path.dirname(this.scriptPath)
      });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', async (code) => {
        if (code !== 0) {
          console.error('Slicer stderr:', stderr);
          reject(new Error(`Code slicer failed with code ${code}: ${stderr}`));
          return;
        }

        try {
          const results = await this.parseResults(actualOutputDir);
          resolve({
            success: true,
            sliceId,
            outputDir: actualOutputDir,
            ...results
          });
        } catch (error) {
          reject(new Error(`Failed to parse results: ${error.message}`));
        }
      });

      process.on('error', (error) => {
        reject(new Error(`Failed to start slicer: ${error.message}`));
      });
    });
  }

  async parseResults(outputDir) {
    try {
      const markdownPath = path.join(outputDir, 'slice.md');
      const markdown = await fs.readFile(markdownPath, 'utf-8');

      const metaPath = path.join(outputDir, 'metadata.json');
      let metadata = {};
      try {
        const metaContent = await fs.readFile(metaPath, 'utf-8');
        metadata = JSON.parse(metaContent);
      } catch (e) {
        // Metadata file might not exist
      }

      return {
        markdown,
        metadata,
        files: metadata.files || [],
        snippets: metadata.snippets || [],
        stats: metadata.stats || {}
      };
    } catch (error) {
      throw new Error(`Failed to parse results: ${error.message}`);
    }
  }
}

const codeSlicer = new CodeSlicerWrapper();

// ============= Helper Functions =============

/**
 * Extract targets from issue or PR body using simple heuristics
 */
function extractTargetsFromText(text) {
  const targets = [];
  const hints = [];

  // Look for code references in backticks
  const codeMatches = text.match(/`([^`]+)`/g);
  if (codeMatches) {
    codeMatches.forEach(match => {
      const cleaned = match.replace(/`/g, '');
      if (cleaned.includes('.') && !cleaned.includes(' ')) {
        targets.push(cleaned);
      }
    });
  }

  // Look for file paths
  const pathMatches = text.match(/([a-zA-Z0-9_-]+\/)+[a-zA-Z0-9_-]+\.[a-zA-Z]{2,4}/g);
  if (pathMatches) {
    targets.push(...pathMatches);
  }

  // Extract technical terms as hints
  const technicalWords = text.match(/\b[A-Z][a-zA-Z0-9]*(?:[A-Z][a-z0-9]+)+\b/g);
  if (technicalWords) {
    hints.push(...new Set(technicalWords));
  }

  return {
    targets: [...new Set(targets)],
    hints: [...new Set(hints)]
  };
}

// ============= API Endpoints =============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'code-slicer-service',
    version: '2.0.0',
    features: ['branch-support', 'branch-comparison', 'issue-analysis', 'pr-analysis']
  });
});

// ============= BRANCH MANAGEMENT ENDPOINTS =============

/**
 * GET /api/slice/branches/:owner/:repo
 * List all branches for a repository
 */
app.get('/api/slice/branches/:owner/:repo', async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const { conn_id } = req.query;

    const branches = await githubHub.listBranches(owner, repo, conn_id);

    res.json({
      success: true,
      owner,
      repo,
      branches,
      count: branches.length
    });

  } catch (error) {
    console.error('List branches error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/slice/branch-info/:owner/:repo/:branch
 * Get detailed information about a specific branch
 */
app.get('/api/slice/branch-info/:owner/:repo/:branch', async (req, res) => {
  try {
    const { owner, repo, branch } = req.params;
    const { conn_id } = req.query;

    const branchInfo = await githubHub.getBranchInfo(owner, repo, branch, conn_id);

    res.json({
      success: true,
      owner,
      repo,
      branch,
      ...branchInfo
    });

  } catch (error) {
    console.error('Get branch info error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/slice/compare
 * Compare two branches and analyze the differences
 */
app.post('/api/slice/compare', async (req, res) => {
  try {
    const {
      repo,
      base_branch,
      compare_branch,
      targets = [],
      context = 15,
      conn_id = null,
      analyze_changes = true
    } = req.body;

    if (!repo || !base_branch || !compare_branch) {
      return res.status(400).json({
        error: 'Missing required fields: repo, base_branch, compare_branch'
      });
    }

    const [owner, repoName] = repo.split('/');

    // Get comparison from GitHub
    const comparison = await githubHub.compareBranches(
      owner,
      repoName,
      base_branch,
      compare_branch,
      conn_id
    );

    if (!analyze_changes) {
      return res.json({
        success: true,
        comparison,
        base_branch,
        compare_branch
      });
    }

    // Clone the compare branch for analysis
    const repoPath = await githubHub.cloneRepo(owner, repoName, compare_branch, conn_id);

    // Extract changed files from comparison
    const changedFiles = comparison.files?.map(f => f.filename) || [];
    const analysisTargets = targets.length > 0 ? targets : changedFiles;

    // Analyze the code
    const result = await codeSlicer.analyze({
      repoPath,
      targets: analysisTargets,
      context,
      promptPack: true
    });

    res.json({
      success: true,
      base_branch,
      compare_branch,
      comparison: {
        ahead_by: comparison.ahead_by,
        behind_by: comparison.behind_by,
        total_commits: comparison.total_commits,
        files_changed: comparison.files?.length || 0
      },
      analysis: {
        sliceId: result.sliceId,
        files_analyzed: result.files?.length || 0,
        snippets_found: result.snippets?.length || 0
      },
      changed_files: changedFiles,
      markdown: result.markdown
    });

  } catch (error) {
    console.error('Branch comparison error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= ENHANCED ANALYSIS ENDPOINTS WITH BRANCH SUPPORT =============

/**
 * POST /api/slice/analyze
 * Analyze repository code with optional branch support
 * NOW SUPPORTS: branch parameter
 */
app.post('/api/slice/analyze', async (req, res) => {
  try {
    const {
      repo,
      branch = null,  // NEW: Optional branch parameter
      targets = [],
      context = 10,
      hints = [],
      max_files = null,
      promptPack = false,
      conn_id = null
    } = req.body;

    if (!repo) {
      return res.status(400).json({
        error: 'Missing required field: repo'
      });
    }

    if (!targets || targets.length === 0) {
      return res.status(400).json({
        error: 'At least one target is required'
      });
    }

    const [owner, repoName] = repo.split('/');

    // Clone with branch support
    const repoPath = await githubHub.cloneRepo(owner, repoName, branch, conn_id);

    const result = await codeSlicer.analyze({
      repoPath,
      targets,
      context,
      hints,
      maxFiles: max_files,
      promptPack
    });

    // Store in database if available
    if (pool) {
      try {
        await pool.query(
          `INSERT INTO code_slices (id, repo, branch, targets, context_lines, created_at)
           VALUES ($1, $2, $3, $4, $5, NOW())`,
          [result.sliceId, repo, branch || 'default', targets, context]
        );
      } catch (dbError) {
        console.error('Database insert error:', dbError);
      }
    }

    res.json({
      success: true,
      repo,
      branch: branch || 'default',
      ...result
    });

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/slice/from-issue
 * Extract context from GitHub issue with branch support
 * NOW SUPPORTS: branch parameter
 */
app.post('/api/slice/from-issue', async (req, res) => {
  try {
    const {
      repo,
      branch = null,  // NEW: Optional branch parameter
      issue_number,
      context = 15,
      extract_targets = true,
      conn_id = null
    } = req.body;

    if (!repo || !issue_number) {
      return res.status(400).json({
        error: 'Missing required fields: repo and issue_number'
      });
    }

    const [owner, repoName] = repo.split('/');

    // Get issue details
    const issue = await githubHub.getIssue(owner, repoName, issue_number, conn_id);

    // Extract targets from issue if requested
    let targets = [];
    let hints = [];

    if (extract_targets) {
      const issueText = `${issue.title}\n\n${issue.body || ''}`;
      const extracted = extractTargetsFromText(issueText);
      targets = extracted.targets;
      hints = extracted.hints;
    }

    if (targets.length === 0) {
      return res.status(400).json({
        error: 'No targets found in issue',
        suggestion: 'Please specify targets manually or improve issue description',
        issue_title: issue.title,
        extracted_hints: hints
      });
    }

    // Clone with branch support
    const repoPath = await githubHub.cloneRepo(owner, repoName, branch, conn_id);

    const result = await codeSlicer.analyze({
      repoPath,
      targets,
      context,
      hints,
      promptPack: true
    });

    res.json({
      success: true,
      repo,
      branch: branch || 'default',
      issue_number,
      issue_title: issue.title,
      extracted_targets: targets,
      extracted_hints: hints,
      ...result
    });

  } catch (error) {
    console.error('Issue analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/slice/from-pr
 * Extract context from Pull Request with branch support
 * NOW SUPPORTS: Automatically uses PR head branch
 */
app.post('/api/slice/from-pr', async (req, res) => {
  try {
    const {
      repo,
      pr_number,
      branch = null,  // NEW: Optional branch override (defaults to PR head branch)
      context = 15,
      analyze_impact = true,
      conn_id = null
    } = req.body;

    if (!repo || !pr_number) {
      return res.status(400).json({
        error: 'Missing required fields: repo and pr_number'
      });
    }

    const [owner, repoName] = repo.split('/');

    // Get PR files
    const prData = await githubHub.getPRFiles(owner, repoName, pr_number, conn_id);
    const files = prData.files || prData;

    // Determine branch: use override, PR head branch, or default
    const targetBranch = branch || prData.head_branch || null;

    // Extract targets from changed files
    const targets = [];
    files.forEach(file => {
      const patch = file.patch || '';
      const functionMatches = patch.match(/^\+\s*(?:def|function|func|public|private|const|let|var)\s+(\w+)/gm);
      if (functionMatches) {
        functionMatches.forEach(match => {
          const functionName = match.replace(/^\+\s*(?:def|function|func|public|private|const|let|var)\s+/, '');
          targets.push(`${file.filename}:${functionName}`);
        });
      }
    });

    // Clone with branch support
    const repoPath = await githubHub.cloneRepo(owner, repoName, targetBranch, conn_id);

    const result = await codeSlicer.analyze({
      repoPath,
      targets: targets.length > 0 ? targets : files.map(f => f.filename),
      context,
      promptPack: true
    });

    res.json({
      success: true,
      repo,
      branch: targetBranch || 'default',
      pr_number,
      changed_files: files.length,
      extracted_targets: targets,
      ...result
    });

  } catch (error) {
    console.error('PR analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= EXISTING ENDPOINTS (UNCHANGED) =============

/**
 * GET /api/slice/result/:sliceId
 * Get slice result
 */
app.get('/api/slice/result/:sliceId', async (req, res) => {
  try {
    const { sliceId } = req.params;
    const { format = 'json' } = req.query;

    const outputDir = path.join(DATA_DIR, 'slices', sliceId);

    try {
      await fs.access(outputDir);
    } catch {
      return res.status(404).json({ error: 'Slice not found' });
    }

    if (format === 'markdown') {
      const markdown = await fs.readFile(path.join(outputDir, 'slice.md'), 'utf-8');
      res.type('text/markdown').send(markdown);
    } else if (format === 'html') {
      const markdown = await fs.readFile(path.join(outputDir, 'slice.md'), 'utf-8');
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Code Slice ${sliceId}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 20px; }
            pre { background: #f6f8fa; padding: 16px; border-radius: 6px; overflow-x: auto; }
            code { font-family: 'SF Mono', Monaco, monospace; font-size: 12px; }
          </style>
        </head>
        <body><pre><code>${markdown.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</code></pre></body>
        </html>
      `;
      res.type('text/html').send(html);
    } else {
      const results = await codeSlicer.parseResults(outputDir);
      res.json(results);
    }

  } catch (error) {
    console.error('Result fetch error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/slice/enrich-prompt
 * Enrich prompt with code context
 */
app.post('/api/slice/enrich-prompt', async (req, res) => {
  try {
    const {
      prompt,
      repo,
      branch = null,  // NEW: Optional branch parameter
      targets,
      context = 10,
      conn_id = null
    } = req.body;

    if (!prompt || !repo || !targets) {
      return res.status(400).json({
        error: 'Missing required fields: prompt, repo, targets'
      });
    }

    const [owner, repoName] = repo.split('/');
    const repoPath = await githubHub.cloneRepo(owner, repoName, branch, conn_id);
    
    const result = await codeSlicer.analyze({
      repoPath,
      targets,
      context
    });

    if (!result.success) {
      return res.status(500).json({ error: 'Code analysis failed' });
    }

    const enrichedPrompt = `
${prompt}

## Code Context${branch ? ` (branch: ${branch})` : ''}

${result.markdown}

---

Please analyze the code above and provide your response.
    `.trim();

    res.json({
      success: true,
      original_prompt: prompt,
      enriched_prompt: enrichedPrompt,
      repo,
      branch: branch || 'default',
      code_snippets: result.snippets?.length || 0,
      affected_files: result.files?.length || 0
    });

  } catch (error) {
    console.error('Prompt enrichment error:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/slice/stats
 * Get statistics
 */
app.get('/api/slice/stats', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_slices,
        COUNT(DISTINCT repo) as unique_repos,
        COUNT(DISTINCT branch) as unique_branches,
        AVG(array_length(targets, 1)) as avg_targets,
        AVG(context_lines) as avg_context
      FROM code_slices
      WHERE created_at > NOW() - INTERVAL '30 days'
    `);

    res.json(stats.rows[0]);

  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============= Server Start =============
async function start() {
  await ensureDirectories();

  app.listen(PORT, () => {
    console.log(`🚀 Code Slicer Service v2.0 running on port ${PORT}`);
    console.log(`📂 Data directory: ${DATA_DIR}`);
    console.log(`💾 Cache directory: ${CACHE_DIR}`);
    console.log(`🔗 GitHub Hub: ${GITHUB_HUB_URL}`);
    console.log(`🤖 LLM Gateway: ${LLM_GATEWAY_URL}`);
    console.log(`🗄️  Database: ${POSTGRES_URL ? 'Connected' : 'Not configured'}`);
    console.log(`\n✨ New Features:`);
    console.log(`   - Branch support on all endpoints`);
    console.log(`   - GET /api/slice/branches/:owner/:repo`);
    console.log(`   - GET /api/slice/branch-info/:owner/:repo/:branch`);
    console.log(`   - POST /api/slice/compare (branch comparison)`);
  });
}

// Error handling
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

start();