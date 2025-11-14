const express = require('express');
const router = express.Router();
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const simpleGit = require('simple-git');
const RedisService = require('../services/redis');

const WORKSPACE_ROOT = '/workspace/repos';

// Get settings helper
async function getAISettings() {
  try {
    const settingsStr = await RedisService.get('settings');
    if (settingsStr) {
      const settings = JSON.parse(settingsStr);
      return settings.ai;
    }
  } catch {
    // Fall back to defaults
  }
  
  return {
    llmGatewayUrl: process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010',
    model: 'gpt-4o',
    temperature: 0.7,
    maxTokens: 500,
    commitStyle: 'conventional'
  };
}

// Tokenize files for context management
router.post('/tokenize', async (req, res) => {
  const { 
    connection_id, 
    repo_name, 
    files = [], 
    model = 'gpt-4o' 
  } = req.body;

  if (!connection_id || !repo_name || files.length === 0) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const aiSettings = await getAISettings();
    const results = {};
    let totalTokens = 0;

    for (const file of files) {
      const filePath = path.join(WORKSPACE_ROOT, connection_id, repo_name, file);
      
      try {
        const content = await fs.readFile(filePath, 'utf8');
        
        // Call LLM Gateway to tokenize
        const response = await axios.post(
          `${aiSettings.llmGatewayUrl}/api/tokenize`,
          {
            text: content,
            model: model || aiSettings.model
          },
          { timeout: 10000 }
        );

        results[file] = {
          tokens: response.data.tokens,
          size: content.length,
          lines: content.split('\n').length
        };
        totalTokens += response.data.tokens;
      } catch (error) {
        results[file] = {
          error: error.message,
          tokens: 0
        };
      }
    }

    // Get model context limits
    const contextLimits = {
      'gpt-4o': 128000,
      'gpt-4': 8192,
      'gpt-3.5-turbo': 4096,
      'claude-3-opus': 200000,
      'claude-3-sonnet': 200000
    };

    const limit = contextLimits[model] || 4096;
    const usage = (totalTokens / limit) * 100;

    res.json({
      files: results,
      total: totalTokens,
      model,
      limit,
      usage: usage.toFixed(2),
      remaining: limit - totalTokens,
      warning: usage > 80 ? 'Approaching context limit' : null
    });
  } catch (error) {
    console.error('Error tokenizing:', error);
    res.status(500).json({ error: error.message });
  }
});

// Generate commit message
router.post('/generate-commit-message', async (req, res) => {
  const { 
    connection_id, 
    repo_name,
    style = 'conventional',
    include_description = true 
  } = req.body;

  if (!connection_id || !repo_name) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const aiSettings = await getAISettings();
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    // Get staged changes
    const diff = await git.diff(['--cached']);
    const status = await git.status();
    
    if (!diff && status.staged.length === 0) {
      return res.status(400).json({ error: 'No staged changes to commit' });
    }

    // Prepare prompt based on style
    let systemPrompt = '';
    switch (style || aiSettings.commitStyle) {
      case 'conventional':
        systemPrompt = `You are a Git commit message generator following the Conventional Commits specification.
Generate a commit message with:
- Type: feat|fix|docs|style|refactor|test|chore|perf
- Optional scope in parentheses
- Description starting with lowercase
- Optional body with more details (if include_description is true)

Example: "feat(auth): add JWT token validation"
Example with body: "fix(api): resolve memory leak in connection pool

The connection pool was not properly releasing resources,
causing memory usage to grow over time."`;
        break;
        
      case 'simple':
        systemPrompt = 'Generate a simple, clear commit message describing the changes. Keep it under 50 characters.';
        break;
        
      case 'detailed':
        systemPrompt = `Generate a detailed commit message with:
- A subject line (50 chars max)
- A blank line
- A detailed body explaining what changed and why
- Bullet points for multiple changes`;
        break;
    }

    const userPrompt = `Generate a commit message for these changes:

Files changed: ${status.staged.join(', ')}

Diff:
\`\`\`diff
${diff.substring(0, 3000)}${diff.length > 3000 ? '\n... (truncated)' : ''}
\`\`\``;

    // Call LLM Gateway
    const response = await axios.post(
      `${aiSettings.llmGatewayUrl}/api/chat/completions`,
      {
        model: aiSettings.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: aiSettings.temperature,
        max_tokens: aiSettings.maxTokens
      },
      { timeout: 30000 }
    );

    const generatedMessage = response.data.choices[0].message.content.trim();

    res.json({
      message: generatedMessage,
      style,
      files: status.staged.length,
      model: aiSettings.model
    });
  } catch (error) {
    console.error('Error generating commit message:', error);
    res.status(500).json({ error: error.message });
  }
});

// Analyze code quality before push
router.post('/analyze-push', async (req, res) => {
  const { connection_id, repo_name, branch = 'main' } = req.body;

  if (!connection_id || !repo_name) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const aiSettings = await getAISettings();
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    const git = simpleGit(repoPath);
    
    // Get diff between local and remote
    const diff = await git.diff([`origin/${branch}...HEAD`]);
    
    if (!diff) {
      return res.json({
        analysis: 'No changes to push',
        issues: [],
        suggestions: []
      });
    }

    const systemPrompt = `You are a code quality and security analyzer. Analyze the following diff for:
1. Potential bugs or errors
2. Security vulnerabilities
3. Performance issues
4. Code style problems
5. Best practice violations

Provide a JSON response with:
{
  "summary": "brief overall assessment",
  "risk_level": "low|medium|high",
  "issues": [
    {
      "severity": "error|warning|info",
      "type": "bug|security|performance|style",
      "file": "filename",
      "line": "line number if applicable",
      "message": "description of the issue"
    }
  ],
  "suggestions": ["list of improvement suggestions"],
  "ready_to_push": true/false
}`;

    const userPrompt = `Analyze this diff for quality issues:

\`\`\`diff
${diff.substring(0, 5000)}${diff.length > 5000 ? '\n... (truncated)' : ''}
\`\`\``;

    // Call LLM Gateway
    const response = await axios.post(
      `${aiSettings.llmGatewayUrl}/api/chat/completions`,
      {
        model: aiSettings.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3, // Lower temperature for more consistent analysis
        max_tokens: 1000
      },
      { timeout: 30000 }
    );

    let analysis;
    try {
      analysis = JSON.parse(response.data.choices[0].message.content);
    } catch {
      // Fallback if response isn't valid JSON
      analysis = {
        summary: response.data.choices[0].message.content,
        risk_level: 'unknown',
        issues: [],
        suggestions: [],
        ready_to_push: true
      };
    }

    res.json({
      ...analysis,
      analyzed_at: new Date().toISOString(),
      model: aiSettings.model
    });
  } catch (error) {
    console.error('Error analyzing push:', error);
    res.status(500).json({ error: error.message });
  }
});

// Summarize pull changes
router.post('/summarize-pull', async (req, res) => {
  const { 
    connection_id, 
    repo_name,
    commits = [],
    files_changed = []
  } = req.body;

  if (!connection_id || !repo_name) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const aiSettings = await getAISettings();
    
    const systemPrompt = `Summarize the following git pull changes in a clear, concise way:
- Group related changes together
- Highlight important changes
- Mention any breaking changes or risks
- Keep the summary brief but informative`;

    const userPrompt = `Summarize these incoming changes:

Commits:
${commits.map(c => `- ${c.hash.substring(0, 7)} ${c.message}`).join('\n')}

Files changed:
${files_changed.join('\n')}

Provide a brief summary for the team.`;

    // Call LLM Gateway
    const response = await axios.post(
      `${aiSettings.llmGatewayUrl}/api/chat/completions`,
      {
        model: aiSettings.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: aiSettings.temperature,
        max_tokens: 500
      },
      { timeout: 30000 }
    );

    const summary = response.data.choices[0].message.content.trim();

    res.json({
      summary,
      commits: commits.length,
      files: files_changed.length,
      model: aiSettings.model
    });
  } catch (error) {
    console.error('Error summarizing pull:', error);
    res.status(500).json({ error: error.message });
  }
});

// Help resolve merge conflicts
router.post('/resolve-conflict', async (req, res) => {
  const { 
    file_content,
    ours_name = 'current branch',
    theirs_name = 'incoming branch',
    context = ''
  } = req.body;

  if (!file_content) {
    return res.status(400).json({ error: 'File content is required' });
  }

  try {
    const aiSettings = await getAISettings();
    
    const systemPrompt = `You are a merge conflict resolver. Given a file with git conflict markers, suggest the best resolution.
Consider:
1. The intent of both changes
2. Which change is more recent or important
3. If both changes can be combined
4. Code correctness and consistency

Provide a JSON response with:
{
  "resolution": "the resolved content without conflict markers",
  "explanation": "brief explanation of the resolution choice",
  "confidence": "high|medium|low"
}`;

    const userPrompt = `Resolve this merge conflict:
${context ? `Context: ${context}\n` : ''}
File content with conflicts:
\`\`\`
${file_content}
\`\`\`

"${ours_name}" is our current branch.
"${theirs_name}" is the incoming branch.`;

    // Call LLM Gateway
    const response = await axios.post(
      `${aiSettings.llmGatewayUrl}/api/chat/completions`,
      {
        model: aiSettings.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.3, // Lower temperature for more deterministic resolution
        max_tokens: 2000
      },
      { timeout: 30000 }
    );

    let resolution;
    try {
      resolution = JSON.parse(response.data.choices[0].message.content);
    } catch {
      // Fallback if response isn't valid JSON
      resolution = {
        resolution: response.data.choices[0].message.content,
        explanation: 'AI suggested resolution',
        confidence: 'medium'
      };
    }

    res.json({
      ...resolution,
      model: aiSettings.model
    });
  } catch (error) {
    console.error('Error resolving conflict:', error);
    res.status(500).json({ error: error.message });
  }
});

// Suggest files for a given task
router.post('/suggest-files', async (req, res) => {
  const { 
    connection_id,
    repo_name,
    query,
    max_files = 10
  } = req.body;

  if (!connection_id || !repo_name || !query) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  try {
    const aiSettings = await getAISettings();
    const repoPath = path.join(WORKSPACE_ROOT, connection_id, repo_name);
    
    // Get file list
    const files = await listRepoFiles(repoPath);
    
    const systemPrompt = `Given a user's task/query and a list of files in a repository, suggest which files are most relevant.
Consider:
1. File names and paths
2. Common patterns (tests with test files, docs with doc files)
3. Related functionality

Return a JSON array of suggested files with relevance scores:
[
  {
    "file": "path/to/file",
    "relevance": 0.9,
    "reason": "brief explanation"
  }
]`;

    const userPrompt = `Task/Query: "${query}"

Repository files:
${files.slice(0, 200).join('\n')}
${files.length > 200 ? `\n... and ${files.length - 200} more files` : ''}

Suggest up to ${max_files} most relevant files for this task.`;

    // Call LLM Gateway
    const response = await axios.post(
      `${aiSettings.llmGatewayUrl}/api/chat/completions`,
      {
        model: aiSettings.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.5,
        max_tokens: 1000
      },
      { timeout: 30000 }
    );

    let suggestions;
    try {
      suggestions = JSON.parse(response.data.choices[0].message.content);
    } catch {
      suggestions = [];
    }

    // Verify suggested files exist
    const validSuggestions = [];
    for (const suggestion of suggestions.slice(0, max_files)) {
      if (files.includes(suggestion.file)) {
        validSuggestions.push(suggestion);
      }
    }

    res.json({
      query,
      suggestions: validSuggestions,
      total_files: files.length,
      model: aiSettings.model
    });
  } catch (error) {
    console.error('Error suggesting files:', error);
    res.status(500).json({ error: error.message });
  }
});

// Helper function to list repository files
async function listRepoFiles(dirPath, basePath = '', files = [], exclude = ['.git', 'node_modules']) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    const relativePath = path.join(basePath, entry.name);
    
    if (exclude.includes(entry.name)) continue;
    
    if (entry.isDirectory()) {
      await listRepoFiles(fullPath, relativePath, files, exclude);
    } else {
      files.push(relativePath);
    }
  }
  
  return files;
}

module.exports = router;
