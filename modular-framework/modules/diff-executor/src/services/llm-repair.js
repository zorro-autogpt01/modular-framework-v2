const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');

class LLMRepairService {
  constructor({ llmGatewayUrl, logger }) {
    this.llmGatewayUrl = llmGatewayUrl;
    this.logger = logger;
  }

  async repairPatch(originalContent, brokenPatch, syntaxError, filePath) {
    try {
      const prompt = this.buildRepairPrompt(originalContent, brokenPatch, syntaxError, filePath);
      
      const response = await axios.post(
        `${this.llmGatewayUrl}/api/v1/chat`,
        {
          modelKey: 'openai:gpt-4o-mini',
          stream: false,
          messages: [
            {
              role: 'system',
              content: `You are a code repair assistant. Fix syntax errors in patches and return ONLY a valid unified diff format patch. Do not include any explanation or markdown formatting.`
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.2,
          max_tokens: 4000
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 30000
        }
      );

      if (response.data && response.data.content) {
        const repairedPatch = this.extractPatch(response.data.content);
        this.logger.info(`LLM repair successful for ${filePath}`);
        return {
          success: true,
          repairedPatch,
          originalError: syntaxError
        };
      }

      throw new Error('Invalid LLM response');
    } catch (error) {
      this.logger.error('LLM repair failed:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  buildRepairPrompt(originalContent, brokenPatch, syntaxError, filePath) {
    const fileExt = path.extname(filePath);
    const language = fileExt === '.ts' || fileExt === '.tsx' ? 'TypeScript' : 'JavaScript';
    
    return `Fix this ${language} patch that has a syntax error.

Original file content:
\`\`\`${language}
${originalContent}
\`\`\`

Broken patch (unified diff format):
\`\`\`diff
${brokenPatch}
\`\`\`

Syntax error:
${syntaxError.error}
${syntaxError.line ? `Line: ${syntaxError.line}` : ''}
${syntaxError.column ? `Column: ${syntaxError.column}` : ''}

Generate a corrected unified diff patch that:
1. Fixes the syntax error
2. Preserves the intended changes
3. Uses proper ${language} syntax
4. Maintains the unified diff format

Return ONLY the corrected patch in unified diff format, no explanations.`;
  }

  extractPatch(llmResponse) {
    // Remove markdown code blocks if present
    let patch = llmResponse;
    
    // Remove ```diff or ``` markers
    patch = patch.replace(/```diff\n?/g, '');
    patch = patch.replace(/```\n?/g, '');
    
    // Trim whitespace
    patch = patch.trim();
    
    // Validate it looks like a diff
    if (!patch.includes('---') || !patch.includes('+++')) {
      throw new Error('Response does not appear to be a valid diff');
    }
    
    return patch;
  }

  async repairAndRetry(stagingPath, targetFiles, originalDiff, validationResults) {
    const repairs = [];
    
    for (const result of validationResults.results) {
      if (!result.valid && !result.skipped) {
        const file = targetFiles.find(f => f.filePath === result.file);
        if (!file) continue;
        
        // Read the original file content
        const originalPath = path.join('/workspace/repos', file.connectionId, file.repoName, file.filePath);
        let originalContent = '';
        
        if (await fs.pathExists(originalPath)) {
          originalContent = await fs.readFile(originalPath, 'utf8');
        }
        
        // Extract the relevant part of the diff for this file
        const fileDiff = this.extractFileDiff(originalDiff, file.filePath);
        
        // Attempt repair
        const repairResult = await this.repairPatch(
          originalContent,
          fileDiff,
          result,
          file.filePath
        );
        
        repairs.push({
          file: file.filePath,
          ...repairResult
        });
      }
    }
    
    return repairs;
  }

  extractFileDiff(fullDiff, filePath) {
    const lines = fullDiff.split('\n');
    const filePatterns = [
      new RegExp(`--- a?/?.*${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      new RegExp(`\\+\\+\\+ b?/?.*${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
    ];
    
    let capturing = false;
    let fileDiff = [];
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (filePatterns.some(p => p.test(line))) {
        capturing = true;
      } else if (capturing && (line.startsWith('--- ') || line.startsWith('diff '))) {
        break;
      }
      
      if (capturing) {
        fileDiff.push(line);
      }
    }
    
    return fileDiff.join('\n');
  }
}

module.exports = LLMRepairService;