// code-slicer-service/server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const { Pool } = require('pg');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3012;

// Environment configuration
const GITHUB_HUB_URL = process.env.GITHUB_HUB_URL || 'http://github-hub-module:3005';
const LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010';
const DATA_DIR = process.env.DATA_DIR || '/data';
const CACHE_DIR = process.env.CACHE_DIR || '/cache';
const POSTGRES_URL = process.env.POSTGRES_URL;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(morgan('combined'));

// Database pool
const pool = POSTGRES_URL ? new Pool({ connectionString: POSTGRES_URL }) : null;

// Ensure directories exist
async function ensureDirectories() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'repos'), { recursive: true });
  await fs.mkdir(path.join(DATA_DIR, 'slices'), { recursive: true });
}

// ============= GitHub Hub Client =============
class GitHubHubClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
    this.axios = axios.create({
      baseURL: `${baseURL}/api`,
      timeout: 60000
    });
  }

  async cloneRepo(owner, repo, branch = 'main') {
    const repoPath = path.join(DATA_DIR, 'repos', `${owner}-${repo}`);
    
    try {
      // Check if already cloned
      await fs.access(repoPath);
      console.log(`Repository ${owner}/${repo} already exists, updating...`);
      
      // Pull latest changes
      return await this.executeCommand('git', ['pull'], repoPath);
    } catch (error) {
      // Clone fresh
      console.log(`Cloning ${owner}/${repo}...`);
      
      const response = await this.axios.post('/repos/clone', {
        owner,
        repo,
        branch,
        destination: repoPath
      });
      
      return repoPath;
    }
  }

  async getFileContent(owner, repo, path, ref = 'main') {
    const response = await this.axios.get(`/repos/${owner}/${repo}/contents/${path}`, {
      params: { ref }
    });
    return response.data;
  }

  async getPRFiles(owner, repo, prNumber) {
    const response = await this.axios.get(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
    return response.data;
  }

  async getIssue(owner, repo, issueNumber) {
    const response = await this.axios.get(`/repos/${owner}/${repo}/issues/${issueNumber}`);
    return response.data;
  }

  async createComment(owner, repo, issueNumber, body) {
    const response = await this.axios.post(
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body }
    );
    return response.data;
  }

  executeCommand(command, args, cwd) {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd, shell: true });
      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', data => stdout += data);
      proc.stderr.on('data', data => stderr += data);

      proc.on('close', code => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`Command failed: ${stderr}`));
      });
    });
  }
}

// ============= LLM Gateway Client =============
class LLMGatewayClient {
  constructor(baseURL) {
    this.baseURL = baseURL;
    this.axios = axios.create({
      baseURL: `${baseURL}/api`,
      timeout: 120000
    });
  }

  async chat(messages, conversationId, metadata = {}) {
    const response = await this.axios.post('/compat/llm-workflows', {
      model_id: 1, // Claude
      conversation_id: conversationId,
      messages,
      metadata: {
        service: 'code-slicer',
        ...metadata
      }
    });
    return response.data;
  }

  async extractKeywords(text, conversationId) {
    const messages = [{
      role: 'user',
      content: `Extract API endpoints, function names, and key technical terms from this text. Return as a JSON array of strings.\n\nText: ${text}`
    }];

    const response = await this.chat(messages, conversationId, { action: 'extract_keywords' });
    
    try {
      // Parse JSON from response
      const match = response.content.match(/\[.*\]/s);
      return match ? JSON.parse(match[0]) : [];
    } catch {
      // Fallback: split by lines and filter
      return response.content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
    }
  }

  async analyzeCode(code, prompt, conversationId) {
    const messages = [{
      role: 'user',
      content: `${prompt}\n\n\`\`\`\n${code}\n\`\`\``
    }];

    return await this.chat(messages, conversationId, { action: 'analyze_code' });
  }
}

// ============= Code Slicer Service =============
class CodeSlicerService {
  constructor() {
    this.scriptPath = path.join(__dirname, 'scripts', 'api_code_slicer.py');
  }

  async analyze(options) {
    const {
      repoPath,
      targets,
      context = 10,
      hints = [],
      language = 'auto',
      apiType = 'http',
      promptPack = false,
      copyFiles = false
    } = options;

    const sliceId = crypto.randomUUID();
    const outputDir = path.join(DATA_DIR, 'slices', sliceId);

    // Build command
    const args = [
      this.scriptPath,
      '--repo', repoPath,
      '--out', outputDir,
      '--context', context.toString(),
      '--language', language,
      '--api-type', apiType
    ];

    // Add targets
    targets.forEach(target => {
      args.push('--target', target);
    });

    // Add hints
    hints.forEach(hint => {
      args.push('--hint', hint);
    });

    // Add optional flags
    if (promptPack) args.push('--prompt-pack');
    if (copyFiles) args.push('--copy-files');

    console.log('Running code slicer:', args.join(' '));

    // Execute
    const startTime = Date.now();
    try {
      await this.executePython(args);
      const duration = Date.now() - startTime;

      // Read results
      const results = await this.parseResults(outputDir);

      return {
        sliceId,
        success: true,
        duration,
        outputDir,
        ...results
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error('Code slicer failed:', error);

      return {
        sliceId,
        success: false,
        duration,
        error: error.message
      };
    }
  }

  async parseResults(outputDir) {
    const results = {
      markdown: null,
      snippets: [],
      graph: null,
      meta: null,
      files: []
    };

    try {
      // Read markdown
      const markdownPath = path.join(outputDir, 'slice.md');
      results.markdown = await fs.readFile(markdownPath, 'utf-8');

      // Read snippets JSONL
      const snippetsPath = path.join(outputDir, 'snippets.jsonl');
      const snippetsContent = await fs.readFile(snippetsPath, 'utf-8');
      results.snippets = snippetsContent
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));

      // Read meta
      const metaPath = path.join(outputDir, 'meta.json');
      const metaContent = await fs.readFile(metaPath, 'utf-8');
      results.meta = JSON.parse(metaContent);

      results.files = results.meta.files || [];

      // Read graph (optional)
      try {
        const graphPath = path.join(outputDir, 'graph.dot');
        results.graph = await fs.readFile(graphPath, 'utf-8');
      } catch {}

    } catch (error) {
      console.error('Error parsing results:', error);
    }

    return results;
  }

  executePython(args) {
    return new Promise((resolve, reject) => {
      const proc = spawn('python3', args, {
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', data => {
        const text = data.toString();
        stdout += text;
        console.log('[Python]', text);
      });

      proc.stderr.on('data', data => {
        const text = data.toString();
        stderr += text;
        console.error('[Python Error]', text);
      });

      proc.on('close', code => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Python script failed with code ${code}: ${stderr}`));
        }
      });
    });
  }
}

// Initialize services
const githubHub = new GitHubHubClient(GITHUB_HUB_URL);
const llmGateway = new LLMGatewayClient(LLM_GATEWAY_URL);
const codeSlicer = new CodeSlicerService();

// ============= Cache Manager =============
class CacheManager {
  constructor() {
    this.cacheDir = CACHE_DIR;
  }

  getCacheKey(repo, targets, context) {
    const data = JSON.stringify({ repo, targets: targets.sort(), context });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  async get(cacheKey) {
    try {
      const cachePath = path.join(this.cacheDir, `${cacheKey}.json`);
      const data = await fs.readFile(cachePath, 'utf-8');
      const cached = JSON.parse(data);

      // Check if cache is still valid (24 hours)
      const age = Date.now() - cached.timestamp;
      if (age < 24 * 60 * 60 * 1000) {
        console.log('Cache hit:', cacheKey);
        return cached.data;
      }

      console.log('Cache expired:', cacheKey);
      return null;
    } catch {
      return null;
    }
  }

  async set(cacheKey, data) {
    try {
      const cachePath = path.join(this.cacheDir, `${cacheKey}.json`);
      await fs.writeFile(cachePath, JSON.stringify({
        timestamp: Date.now(),
        data
      }));
      console.log('Cache set:', cacheKey);
    } catch (error) {
      console.error('Cache set failed:', error);
    }
  }
}

const cache = new CacheManager();

// ============= API Routes =============

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'code-slicer',
    version: '1.0.0',
    github_hub: GITHUB_HUB_URL,
    llm_gateway: LLM_GATEWAY_URL
  });
});

// Main analysis endpoint
app.post('/api/slice/analyze', async (req, res) => {
  try {
    const {
      repo, // Format: "owner/repo"
      branch = 'main',
      targets,
      context = 10,
      hints = [],
      language = 'auto',
      api_type = 'http',
      prompt_pack = false,
      copy_files = false,
      use_cache = true
    } = req.body;

    if (!repo || !targets || targets.length === 0) {
      return res.status(400).json({
        error: 'Missing required fields: repo and targets'
      });
    }

    // Check cache
    if (use_cache) {
      const cacheKey = cache.getCacheKey(repo, targets, context);
      const cached = await cache.get(cacheKey);
      if (cached) {
        return res.json({ ...cached, from_cache: true });
      }
    }

    // Clone repository
    const [owner, repoName] = repo.split('/');
    const repoPath = await githubHub.cloneRepo(owner, repoName, branch);

    // Run analysis
    const result = await codeSlicer.analyze({
      repoPath,
      targets,
      context,
      hints,
      language,
      apiType: api_type,
      promptPack: prompt_pack,
      copyFiles: copy_files
    });

    if (!result.success) {
      return res.status(500).json({
        error: 'Analysis failed',
        details: result.error
      });
    }

    // Store in database if available
    if (pool) {
      await pool.query(
        `INSERT INTO code_slices (slice_id, repo, targets, context_lines, hints, markdown_output, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          result.sliceId,
          repo,
          targets,
          context,
          hints,
          result.markdown,
          JSON.stringify(result.meta)
        ]
      );
    }

    // Cache result
    if (use_cache) {
      const cacheKey = cache.getCacheKey(repo, targets, context);
      await cache.set(cacheKey, result);
    }

    res.json(result);

  } catch (error) {
    console.error('Analysis error:', error);
    res.status(500).json({
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Extract context from GitHub issue
app.post('/api/slice/from-issue', async (req, res) => {
  try {
    const { repo, issue_number, context = 15, use_llm = true } = req.body;

    if (!repo || !issue_number) {
      return res.status(400).json({
        error: 'Missing required fields: repo and issue_number'
      });
    }

    const [owner, repoName] = repo.split('/');

    // Get issue details
    const issue = await githubHub.getIssue(owner, repoName, issue_number);

    // Extract keywords using LLM
    let targets = [];
    let hints = [];

    if (use_llm) {
      const conversationId = `issue_${repo.replace('/', '_')}_${issue_number}`;
      const keywords = await llmGateway.extractKeywords(
        `${issue.title}\n\n${issue.body}`,
        conversationId
      );

      // Separate into targets (looks like routes/functions) and hints
      keywords.forEach(keyword => {
        if (keyword.startsWith('/') || keyword.includes('::') || keyword.includes('.')) {
          targets.push(keyword);
        } else {
          hints.push(keyword);
        }
      });
    }

    // If no targets found, return error with suggestions
    if (targets.length === 0) {
      return res.status(400).json({
        error: 'No targets found in issue',
        suggestion: 'Please specify targets manually or improve issue description',
        extracted_hints: hints
      });
    }

    // Clone and analyze
    const repoPath = await githubHub.cloneRepo(owner, repoName);
    const result = await codeSlicer.analyze({
      repoPath,
      targets,
      context,
      hints,
      promptPack: true
    });

    res.json({
      ...result,
      issue_number,
      extracted_targets: targets,
      extracted_hints: hints
    });

  } catch (error) {
    console.error('Issue analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Extract context from Pull Request
app.post('/api/slice/from-pr', async (req, res) => {
  try {
    const { repo, pr_number, context = 15, analyze_impact = true } = req.body;

    if (!repo || !pr_number) {
      return res.status(400).json({
        error: 'Missing required fields: repo and pr_number'
      });
    }

    const [owner, repoName] = repo.split('/');

    // Get PR files
    const files = await githubHub.getPRFiles(owner, repoName, pr_number);

    // Extract function names from changed files
    const targets = [];
    files.forEach(file => {
      // Simple heuristic: look for function definitions in the patch
      const patch = file.patch || '';
      const functionMatches = patch.match(/^\+\s*(?:def|function|func|public|private)\s+(\w+)/gm);
      if (functionMatches) {
        functionMatches.forEach(match => {
          const functionName = match.replace(/^\+\s*(?:def|function|func|public|private)\s+/, '');
          targets.push(`${file.filename}:${functionName}`);
        });
      }
    });

    // Analyze repository
    const repoPath = await githubHub.cloneRepo(owner, repoName);
    const result = await codeSlicer.analyze({
      repoPath,
      targets: targets.length > 0 ? targets : files.map(f => f.filename),
      context,
      promptPack: true
    });

    res.json({
      ...result,
      pr_number,
      changed_files: files.length,
      extracted_targets: targets
    });

  } catch (error) {
    console.error('PR analysis error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get slice result
app.get('/api/slice/result/:sliceId', async (req, res) => {
  try {
    const { sliceId } = req.params;
    const { format = 'json' } = req.query;

    const outputDir = path.join(DATA_DIR, 'slices', sliceId);

    // Check if exists
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
      // Simple conversion (you might want to use a proper markdown parser)
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

// Enrich prompt with code context
app.post('/api/slice/enrich-prompt', async (req, res) => {
  try {
    const { prompt, repo, targets, context = 10 } = req.body;

    if (!prompt || !repo || !targets) {
      return res.status(400).json({
        error: 'Missing required fields: prompt, repo, targets'
      });
    }

    // Analyze code
    const [owner, repoName] = repo.split('/');
    const repoPath = await githubHub.cloneRepo(owner, repoName);
    
    const result = await codeSlicer.analyze({
      repoPath,
      targets,
      context
    });

    if (!result.success) {
      return res.status(500).json({ error: 'Code analysis failed' });
    }

    // Build enriched prompt
    const enrichedPrompt = `
${prompt}

## Code Context

${result.markdown}

---

Please analyze the code above and provide your response.
    `.trim();

    res.json({
      original_prompt: prompt,
      enriched_prompt: enrichedPrompt,
      code_snippets: result.snippets.length,
      affected_files: result.files.length
    });

  } catch (error) {
    console.error('Prompt enrichment error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get statistics
app.get('/api/slice/stats', async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_slices,
        COUNT(DISTINCT repo) as unique_repos,
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
    console.log(`🚀 Code Slicer Service running on port ${PORT}`);
    console.log(`📂 Data directory: ${DATA_DIR}`);
    console.log(`💾 Cache directory: ${CACHE_DIR}`);
    console.log(`🔗 GitHub Hub: ${GITHUB_HUB_URL}`);
    console.log(`🤖 LLM Gateway: ${LLM_GATEWAY_URL}`);
    console.log(`🗄️  Database: ${POSTGRES_URL ? 'Connected' : 'Not configured'}`);
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