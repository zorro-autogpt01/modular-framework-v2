const axios = require('axios');
const Ajv = require('ajv');
const micromatch = require('micromatch');
const { RELEVANT_FILES_V1, CODE_CHANGES_V1 } = require('../schemas/repoops');
const { logDebug, logInfo, logWarn, logError } = require('../logger');
const { execRemote } = require('../runnerClient');

// Configuration from environment
const GITHUB_HUB_BASE = (process.env.GITHUB_HUB_BASE || 'http://github-hub:3002').replace(/\/$/, '');
const LLM_GATEWAY_BASE = (process.env.LLM_GATEWAY_API_BASE || 'http://llm-gateway:3010/api').replace(/\/$/, '');
const LLM_GATEWAY_CHAT = (process.env.LLM_GATEWAY_CHAT_URL || `${LLM_GATEWAY_BASE}/compat/llm-workflows`).replace(/\/$/, '');

const MAX_INPUT_TOKENS = Number(process.env.REPOOPS_MAX_INPUT_TOKENS || 48000);
const MAX_FILES = Number(process.env.REPOOPS_MAX_FILES || 20);
const MAX_FILE_KB = Number(process.env.REPOOPS_MAX_FILE_KB || 64);
const MAX_TOTAL_KB = Number(process.env.REPOOPS_MAX_TOTAL_KB || 512);
const TEST_TIMEOUT_MS = Number(process.env.REPOOPS_TEST_TIMEOUT_MS || 900000);
const GITHUB_CLONE_TOKEN = process.env.GITHUB_CLONE_TOKEN || '';

const ajv = new Ajv({ allErrors: true, strict: false });

/**
 * GitHub Hub client wrapper
 */
class GitHubHubClient {
  constructor(connId) {
    this.connId = connId;
    this.baseUrl = GITHUB_HUB_BASE;
  }

  async _req(method, path, data = null, params = {}) {
    const url = `${this.baseUrl}${path}`;
    const config = {
      method,
      url,
      params: { ...params, conn_id: this.connId },
      timeout: 30000
    };
    if (data) config.data = data;
    
    try {
      const resp = await axios(config);
      return resp.data;
    } catch (e) {
      const msg = e?.response?.data?.detail || e?.response?.data?.error || e.message;
      logError('github_hub_error', { method, path, status: e?.response?.status, msg });
      throw new Error(`GitHub Hub ${method} ${path}: ${msg}`);
    }
  }

  async getConnection() {
    const data = await this._req('GET', `/api/connections/${this.connId}`);
    return data.connection || data;
  }

  async listBranches() {
    const data = await this._req('GET', '/api/branches');
    return data.branches || [];
  }

  async createBranch(newBranch, fromBranch) {
    return await this._req('POST', '/api/branch', null, { new: newBranch, from: fromBranch });
  }

  async getTree(branch, recursive = true, pathPrefix = null) {
    const params = { branch, recursive };
    if (pathPrefix) params.path = pathPrefix;
    const data = await this._req('GET', '/api/tree', null, params);
    return data.items || [];
  }

  async getFile(path, branch) {
    return await this._req('GET', '/api/file', null, { path, branch });
  }

  async batchCommit(branch, message, changes) {
    return await this._req('POST', '/api/batch/commit', { branch, message, changes });
  }

  async deleteFile(path, sha, message, branch) {
    return await this._req('DELETE', '/api/file', null, { path, sha, message, branch });
  }

  async compare(base, head) {
    return await this._req('GET', '/api/compare', null, { base, head });
  }

  async createPR({ title, head, base, body, draft = false }) {
    const data = await this._req('POST', '/api/pr', { title, head, base, body, draft });
    return data.pull_request || data;
  }
}

/**
 * Robust extractor for gateway responses (covers Responses API and Chat).
 */
function extractContentFromGatewayResponse(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;

  // direct fields
  let content =
    data?.content ||
    data?.message?.content ||
    data?.choices?.[0]?.message?.content ||
    '';

  if (content) return String(content);

  // Responses API variants
  if (Array.isArray(data.output_text)) {
    const joined = data.output_text.join('');
    if (joined) return joined;
  }

  if (Array.isArray(data.output)) {
    const parts = [];
    for (const item of data.output) {
      const arr = item?.content;
      if (Array.isArray(arr)) {
        for (const p of arr) {
          if (typeof p?.text === 'string') parts.push(p.text);
          else if (typeof p?.content === 'string') parts.push(p.content);
        }
      }
    }
    if (parts.length) return parts.join('');
  }

  // If gateway wrapped original in { raw }
  if (data.raw) {
    const r = data.raw;
    const rawDirect =
      r?.content ||
      r?.message?.content ||
      r?.choices?.[0]?.message?.content ||
      '';
    if (rawDirect) return rawDirect;
    if (Array.isArray(r.output_text)) {
      const j = r.output_text.join('');
      if (j) return j;
    }
    if (Array.isArray(r.output)) {
      const parts = [];
      for (const item of r.output) {
        const arr = item?.content;
        if (Array.isArray(arr)) {
          for (const p of arr) {
            if (typeof p?.text === 'string') parts.push(p.text);
            else if (typeof p?.content === 'string') parts.push(p.content);
          }
        }
      }
      if (parts.length) return parts.join('');
    }
  }

  // Deep walk fallback
  const acc = [];
  const walk = (v) => {
    if (!v) return;
    if (typeof v === 'string') { acc.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') {
      if (typeof v.text === 'string') acc.push(v.text);
      if (typeof v.content === 'string') acc.push(v.content);
      for (const k of Object.keys(v)) walk(v[k]);
    }
  };
  walk(data);
  return acc.join('');
}

/**
 * LLM interaction helpers
 */
async function callLLM({ model, temperature, messages, schema, corr }) {
  const systemGuard = [
    'You are a code analysis assistant that MUST return exactly one JSON object.',
    'Rules:',
    '- Do NOT include explanations, markdown, or code fences.',
    '- Output MUST be valid JSON matching the schema exactly.',
    '- No trailing commas. No comments.',
    'JSON Schema:',
    JSON.stringify(schema, null, 2)
  ].join('\n');

  const fullMessages = [
    { role: 'system', content: systemGuard },
    ...messages
  ];

  logInfo('repoops_llm_call', { corr, model, messageCount: fullMessages.length });

  const resp = await axios.post(LLM_GATEWAY_CHAT, {
    model,
    temperature: temperature ?? 0.2,
    messages: fullMessages,
    stream: false,
    metadata: { correlation_id: corr, repoops: true }
  }, { timeout: 90000 });

  // Hardened extraction (supports gpt-5 Responses API payloads)
  const content = extractContentFromGatewayResponse(resp.data);

  logDebug('repoops_llm_response', { corr, contentLen: (content || '').length, preview: String(content || '').slice(0, 300) });
  return content;
}

function parseJSON(text) {
  const s = String(text || '').trim();
  
  // Try direct parse
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === 'string') {
      try { return JSON.parse(parsed); } catch {}
    }
    return parsed;
  } catch {}

  // Try extracting from code fence
  const match = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (match) {
    try {
      const parsed = JSON.parse(match[1]);
      if (typeof parsed === 'string') {
        try { return JSON.parse(parsed); } catch {}
      }
      return parsed;
    } catch {}
  }

  // Try finding JSON object boundaries
  const blocks = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        blocks.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      if (typeof parsed === 'string') {
        try { return JSON.parse(parsed); } catch {}
      }
      return parsed;
    } catch {}
  }

  return null;
}

async function callLLMWithRetry({ model, temperature, messages, schema, corr, maxRetries = 2 }) {
  const validate = ajv.compile(schema);
  let attempt = 0;

  while (attempt <= maxRetries) {
    const raw = await callLLM({ model, temperature, messages, schema, corr });
    const parsed = parseJSON(raw);

    if (!parsed) {
      logWarn('repoops_json_parse_failed', { corr, attempt, rawPreview: raw.slice(0, 500) });
      if (attempt < maxRetries) {
        messages.push({
          role: 'assistant',
          content: raw
        });
        messages.push({
          role: 'user',
          content: 'Your output was not valid JSON. Return only a JSON object matching the schema. No markdown, no explanations.'
        });
        attempt++;
        continue;
      }
      throw new Error('LLM returned invalid JSON after retries');
    }

    const valid = validate(parsed);
    if (valid) {
      logInfo('repoops_validation_passed', { corr, attempt });
      return { json: parsed, raw };
    }

    const errors = (validate.errors || []).map(e => 
      `${e.instancePath || 'root'}: ${e.message || 'error'}`
    ).join('; ');

    logWarn('repoops_validation_failed', { corr, attempt, errors });

    if (attempt < maxRetries) {
      messages.push({
        role: 'assistant',
        content: raw
      });
      messages.push({
        role: 'user',
        content: `Your output failed schema validation. Errors: ${errors}\n\nReturn a corrected JSON object that passes validation.`
      });
      attempt++;
      continue;
    }

    throw new Error(`Schema validation failed after ${maxRetries} retries: ${errors}`);
  }
}

/**
 * File selection and filtering
 */
function matchesGlobs(path, globs) {
  if (!globs || !globs.length) return true;
  return globs.some(g => micromatch.isMatch(path, g, { dot: true }));
}

function shouldIncludeFile(item, { allowPaths, denyPaths, languageHints }) {
  const path = item.path || '';
  
  // Deny takes precedence
  if (denyPaths && denyPaths.length && matchesGlobs(path, denyPaths)) {
    return { include: false, reason: 'denied_by_policy' };
  }

  // Check allow list
  if (allowPaths && allowPaths.length && !matchesGlobs(path, allowPaths)) {
    return { include: false, reason: 'not_in_allowlist' };
  }

  // Skip common excludes
  const excludePatterns = [
    'node_modules/**', '.venv/**', 'venv/**', 'dist/**', 'build/**',
    '.git/**', '.next/**', '__pycache__/**', '*.pyc',
    '*.jpg', '*.jpeg', '*.png', '*.gif', '*.svg', '*.ico',
    '*.woff', '*.woff2', '*.ttf', '*.eot',
    '*.zip', '*.tar', '*.gz', '*.pdf', '*.exe', '*.dll', '*.so'
  ];
  
  if (matchesGlobs(path, excludePatterns)) {
    return { include: false, reason: 'binary_or_build_artifact' };
  }

  // Language hints (optional boost)
  if (languageHints && languageHints.length) {
    const ext = path.split('.').pop();
    if (languageHints.includes(ext)) {
      return { include: true, reason: 'matches_language_hint' };
    }
  }

  // Include by default if under common source directories
  const includePatterns = [
    'src/**', 'lib/**', 'app/**', 'server/**', 'client/**',
    'tests/**', 'test/**', '__tests__/**', 'integration/**',
    '*.md', 'package.json', 'pyproject.toml', 'requirements.txt',
    'tsconfig.json', 'jest.config.js', 'Makefile', 'Dockerfile'
  ];

  if (matchesGlobs(path, includePatterns)) {
    return { include: true, reason: 'common_source_or_config' };
  }

  return { include: true, reason: 'default_include' };
}

/**
 * Phase 1: File Discovery
 */
async function runDiscovery({ connId, baseBranch, changeRequest, allowPaths, denyPaths, languageHints, model, temperature, corr }) {
  logInfo('repoops_discovery_start', { corr, connId, baseBranch });

  const client = new GitHubHubClient(connId);
  const conn = await client.getConnection();
  const tree = await client.getTree(baseBranch, true);

  // Filter and rank files
  const candidates = [];
  for (const item of tree) {
    if (item.type !== 'blob') continue;
    const check = shouldIncludeFile(item, { allowPaths, denyPaths, languageHints });
    if (check.include) {
      candidates.push({
        path: item.path,
        size: item.size || 0,
        reason: check.reason
      });
    }
  }

  // Sort: smaller files and better names first
  candidates.sort((a, b) => {
    const aScore = (a.reason === 'matches_language_hint' ? -1000 : 0) + (a.size || 0);
    const bScore = (b.reason === 'matches_language_hint' ? -1000 : 0) + (b.size || 0);
    return aScore - bScore;
  });

  const topCandidates = candidates.slice(0, 200);

  // Fetch key context files
  const contextPaths = ['README.md', 'package.json', 'pyproject.toml', 'requirements.txt'];
  const contextFiles = [];
  
  for (const path of contextPaths) {
    const item = tree.find(t => t.path === path);
    if (item && item.size < MAX_FILE_KB * 1024) {
      try {
        const file = await client.getFile(path, baseBranch);
        if (file.decoded_content) {
          contextFiles.push({ path, content: file.decoded_content.slice(0, 8000) });
        }
      } catch {}
    }
  }

  // Build discovery prompt
  const treeList = topCandidates.slice(0, 100).map(c => 
    `  ${c.path} (${Math.round(c.size / 1024)}KB)`
  ).join('\n');

  const contextContent = contextFiles.map(f => 
    `---- FILE: ${f.path} ----\n${f.content}\n`
  ).join('\n');

  const userMessage = [
    `Change request: ${changeRequest}`,
    '',
    `Repository: ${conn.repo_url || conn.name}`,
    `Base branch: ${baseBranch}`,
    languageHints?.length ? `Language hints: ${languageHints.join(', ')}` : '',
    '',
    'Repository tree (top candidates):',
    treeList,
    '',
    contextContent ? 'Key files:\n' + contextContent : '',
    '',
    'Constraints:',
    `- Max total content: ${MAX_TOTAL_KB}KB`,
    `- Max files to select: ${MAX_FILES}`,
    allowPaths?.length ? `- Allowed paths: ${allowPaths.join(', ')}` : '',
    denyPaths?.length ? `- Denied paths: ${denyPaths.join(', ')}` : '',
    '',
    'Return relevant_files.v1 JSON identifying the minimal set of files needed.'
  ].filter(Boolean).join('\n');

  const result = await callLLMWithRetry({
    model,
    temperature,
    messages: [{ role: 'user', content: userMessage }],
    schema: RELEVANT_FILES_V1,
    corr
  });

  logInfo('repoops_discovery_done', { 
    corr, 
    filesSelected: result.json.files?.length || 0,
    filesToCreate: result.json.created_files?.length || 0 
  });

  return {
    discovery: result.json,
    raw: result.raw,
    candidates: topCandidates.length,
    contextFiles: contextFiles.length
  };
}

/**
 * Phase 2: Change Proposal
 */
async function runProposal({ connId, baseBranch, changeRequest, discovery, allowPaths, denyPaths, model, temperature, corr }) {
  logInfo('repoops_proposal_start', { corr, filesCount: discovery.files?.length || 0 });

  const client = new GitHubHubClient(connId);
  const filesToFetch = (discovery.files || []).slice(0, MAX_FILES);
  
  // Fetch file contents with size limits
  const fileContents = [];
  let totalBytes = 0;

  for (const { path } of filesToFetch) {
    try {
      const file = await client.getFile(path, baseBranch);
      const content = file.decoded_content || '';
      const sizeKB = Buffer.byteLength(content, 'utf8') / 1024;

      if (sizeKB > MAX_FILE_KB) {
        logWarn('repoops_file_too_large', { corr, path, sizeKB });
        continue;
      }

      if ((totalBytes + sizeKB * 1024) > (MAX_TOTAL_KB * 1024)) {
        logWarn('repoops_budget_exceeded', { corr, path, totalKB: totalBytes / 1024 });
        break;
      }

      fileContents.push({ path, content, sizeKB });
      totalBytes += sizeKB * 1024;
    } catch (e) {
      logWarn('repoops_file_fetch_failed', { corr, path, error: e.message });
    }
  }

  // Build proposal prompt
  const filesList = fileContents.map(f => f.path).join(', ');
  const filesContent = fileContents.map(f => 
    `---- FILE: ${f.path} ----\n${f.content}\n`
  ).join('\n');

  const userMessage = [
    `Change request: ${changeRequest}`,
    '',
    `Files to modify or reference: ${filesList}`,
    '',
    'File contents:',
    filesContent,
    '',
    'Constraints:',
    `- Provide COMPLETE file content for create/update operations (no patches)`,
    `- Max total changes: ${MAX_TOTAL_KB}KB`,
    allowPaths?.length ? `- Allowed paths: ${allowPaths.join(', ')}` : '',
    denyPaths?.length ? `- Denied paths: ${denyPaths.join(', ')}` : '',
    `- Add or update tests as appropriate`,
    '',
    'Return code_changes.v1 JSON with full file replacements.'
  ].filter(Boolean).join('\n');

  const result = await callLLMWithRetry({
    model,
    temperature,
    messages: [{ role: 'user', content: userMessage }],
    schema: CODE_CHANGES_V1,
    corr
  });

  logInfo('repoops_proposal_done', { 
    corr, 
    changesCount: result.json.changes?.length || 0,
    testsCount: result.json.tests?.length || 0 
  });

  return {
    proposed: result.json,
    raw: result.raw,
    budget: {
      files_fetched: fileContents.length,
      total_kb: Math.round(totalBytes / 1024)
    }
  };
}

/**
 * Phase 3: Apply Changes
 */
async function applyChanges({ connId, baseBranch, headBranch, plan, guardrails, corr }) {
  logInfo('repoops_apply_start', { corr, connId, headBranch, changesCount: plan.changes?.length || 0 });

  const client = new GitHubHubClient(connId);
  
  // Ensure branch exists
  try {
    await client.createBranch(headBranch, baseBranch);
    logInfo('repoops_branch_created', { corr, branch: headBranch });
  } catch (e) {
    if (e.message.includes('already exists') || e.message.includes('409')) {
      logInfo('repoops_branch_exists', { corr, branch: headBranch });
    } else {
      throw e;
    }
  }

  const { allowPaths, denyPaths, maxChangedFiles = 50, maxTotalKB = MAX_TOTAL_KB } = guardrails || {};
  const changes = plan.changes || [];
  
  // Filter by guardrails
  const applied = [];
  const skipped = [];
  let totalBytes = 0;

  for (const change of changes) {
    const { path, operation, content } = change;

    // Check allowlist/denylist
    if (denyPaths?.length && matchesGlobs(path, denyPaths)) {
      skipped.push({ path, operation, reason: 'denied_by_policy' });
      continue;
    }
    if (allowPaths?.length && !matchesGlobs(path, allowPaths)) {
      skipped.push({ path, operation, reason: 'not_in_allowlist' });
      continue;
    }

    // Check file count
    if (applied.length >= maxChangedFiles) {
      skipped.push({ path, operation, reason: 'max_files_exceeded' });
      continue;
    }

    // Check size for create/update
    if (operation !== 'delete') {
      const sizeBytes = Buffer.byteLength(content || '', 'utf8');
      if ((totalBytes + sizeBytes) > (maxTotalKB * 1024)) {
        skipped.push({ path, operation, reason: 'size_budget_exceeded' });
        continue;
      }
      totalBytes += sizeBytes;
    }

    applied.push(change);
  }

  if (!applied.length) {
    logWarn('repoops_no_changes_applied', { corr, skippedCount: skipped.length });
    return { applied: [], skipped, commit_sha: null };
  }

  // Split into batch commit and deletes
  const batchChanges = [];
  const deletes = [];

  for (const change of applied) {
    if (change.operation === 'delete') {
      deletes.push(change);
    } else {
      batchChanges.push({
        path: change.path,
        content: change.content,
        mode: '100644'
      });
    }
  }

  // Apply batch commit
  let commitSha = null;
  if (batchChanges.length) {
    const batchResult = await client.batchCommit(
      headBranch,
      plan.commit_message || 'chore: apply changes',
      batchChanges
    );
    commitSha = batchResult.commit_sha || batchResult.sha;
    logInfo('repoops_batch_commit_done', { corr, filesChanged: batchChanges.length, commitSha });
  }

  // Apply deletes individually
  for (const change of deletes) {
    try {
      const file = await client.getFile(change.path, headBranch);
      await client.deleteFile(
        change.path,
        file.sha,
        `chore: delete ${change.path}`,
        headBranch
      );
      logInfo('repoops_file_deleted', { corr, path: change.path });
    } catch (e) {
      logError('repoops_delete_failed', { corr, path: change.path, error: e.message });
      skipped.push({ path: change.path, operation: 'delete', reason: `delete_failed: ${e.message}` });
    }
  }

  // Get diff summary
  let compare = null;
  try {
    compare = await client.compare(baseBranch, headBranch);
  } catch (e) {
    logWarn('repoops_compare_failed', { corr, error: e.message });
  }

  logInfo('repoops_apply_done', { corr, applied: applied.length, skipped: skipped.length });

  return {
    ok: true,
    commit_sha: commitSha,
    compare,
    applied: applied.map(c => ({ 
      path: c.path, 
      operation: c.operation,
      size: Buffer.byteLength(c.content || '', 'utf8')
    })),
    skipped
  };
}

/**
 * Phase 4: Test on Runner
 */
async function runTests({ connId, headBranch, runner, commands, timeoutMs, corr }) {
  logInfo('repoops_test_start', { corr, runner, commandsCount: commands?.length || 0 });

  const client = new GitHubHubClient(connId);
  const conn = await client.getConnection();
  
  // Extract org/repo from repo_url
  const repoUrl = conn.repo_url || '';
  const match = repoUrl.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/);
  if (!match) {
    throw new Error('Could not parse repository URL');
  }
  const orgRepo = match[1];

  const runId = `test_${Date.now().toString(36)}`;
  const workdir = `/workspace/${runId}`;

  // Build clone sequence
  const cloneUrl = GITHUB_CLONE_TOKEN 
    ? `https://${GITHUB_CLONE_TOKEN}@github.com/${orgRepo}.git`
    : `https://github.com/${orgRepo}.git`;

  const setupCommands = [
    `rm -rf ${workdir} && mkdir -p ${workdir}`,
    `cd ${workdir} && git init`,
    `cd ${workdir} && git config advice.detachedHead false`,
    `cd ${workdir} && git remote add origin ${cloneUrl}`,
    `cd ${workdir} && git fetch --depth 1 origin ${headBranch}`,
    `cd ${workdir} && git checkout -b ${headBranch} FETCH_HEAD`
  ];

  const testCommands = (commands || []).map(cmd => `cd ${workdir} && ${cmd}`);
  const allCommands = [...setupCommands, ...testCommands];

  const results = [];
  for (const [idx, cmd] of allCommands.entries()) {
    const isSetup = idx < setupCommands.length;
    const label = isSetup ? `setup_${idx}` : `test_${idx - setupCommands.length}`;

    logInfo('repoops_test_exec', { corr, label, cmd: cmd.slice(0, 100) });

    try {
      const result = await execRemote({
        target: runner,
        kind: 'bash',
        code: cmd,
        cwd: workdir,
        env: GITHUB_CLONE_TOKEN ? { GITHUB_TOKEN: GITHUB_CLONE_TOKEN } : {},
        timeoutMs: timeoutMs || TEST_TIMEOUT_MS
      });

      results.push({
        cmd: isSetup ? '<setup>' : commands[idx - setupCommands.length],
        exitCode: result.exitCode,
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        killed: result.killed || false
      });

      if (result.exitCode !== 0 && isSetup) {
        logError('repoops_setup_failed', { corr, label, exitCode: result.exitCode });
        throw new Error(`Setup failed at ${label}`);
      }

      if (result.exitCode !== 0 && !isSetup) {
        logWarn('repoops_test_failed', { corr, label, exitCode: result.exitCode });
      }
    } catch (e) {
      results.push({
        cmd: isSetup ? '<setup>' : commands[idx - setupCommands.length],
        exitCode: -1,
        error: e.message,
        stdout: '',
        stderr: e.message
      });
      
      if (isSetup) throw e;
    }
  }

  const allPassed = results
    .filter(r => !r.cmd.includes('<setup>'))
    .every(r => r.exitCode === 0);

  logInfo('repoops_test_done', { corr, allPassed, resultsCount: results.length });

  return {
    ok: allPassed,
    results: results.filter(r => !r.cmd.includes('<setup>'))
  };
}

/**
 * Phase 5: Create PR
 */
async function createPR({ connId, baseBranch, headBranch, title, body, draft, corr }) {
  logInfo('repoops_pr_start', { corr, headBranch, baseBranch });

  const client = new GitHubHubClient(connId);
  const pr = await client.createPR({ title, head: headBranch, base: baseBranch, body, draft });

  logInfo('repoops_pr_created', { corr, prNumber: pr.number, url: pr.html_url });

  return {
    ok: true,
    pr: {
      number: pr.number,
      url: pr.html_url || pr.url,
      title: pr.title
    }
  };
}

module.exports = {
  runDiscovery,
  runProposal,
  applyChanges,
  runTests,
  createPR
};