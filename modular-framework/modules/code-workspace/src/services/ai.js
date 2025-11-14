const axios = require('axios');
const RedisService = require('./redis');

class AIService {
  constructor() {
    this.llmGatewayUrl = process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010';
    this.defaultModel = 'gpt-4o';
    this.settings = null;
  }

  async getSettings() {
    if (this.settings) {
      return this.settings;
    }

    try {
      const settingsStr = await RedisService.get('settings');
      if (settingsStr) {
        const settings = JSON.parse(settingsStr);
        this.settings = settings.ai;
        return this.settings;
      }
    } catch (error) {
      console.error('Error loading AI settings:', error);
    }

    // Default settings
    return {
      enabled: true,
      llmGatewayUrl: this.llmGatewayUrl,
      model: this.defaultModel,
      temperature: 0.7,
      maxTokens: 500,
      commitStyle: 'conventional'
    };
  }

  async generateCommitMessage(diff, stagedFiles) {
    const settings = await this.getSettings();
    
    if (!settings.enabled || !settings.features?.commitMessages) {
      return null;
    }

    try {
      const prompt = this.buildCommitMessagePrompt(diff, stagedFiles, settings.commitStyle);
      
      const response = await axios.post(
        `${settings.llmGatewayUrl}/api/chat/completions`,
        {
          model: settings.model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user }
          ],
          temperature: settings.temperature,
          max_tokens: settings.maxTokens
        },
        { timeout: 30000 }
      );

      return response.data.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error generating commit message:', error.message);
      return null;
    }
  }

  buildCommitMessagePrompt(diff, stagedFiles, style) {
    const prompts = {
      conventional: {
        system: `Generate a commit message following the Conventional Commits specification.
Format: type(scope): description
Types: feat, fix, docs, style, refactor, test, chore, perf
Keep the description concise and clear.`,
        user: `Generate a commit message for these changes:
Files: ${stagedFiles.join(', ')}
Diff preview: ${diff.substring(0, 1000)}`
      },
      simple: {
        system: 'Generate a simple, clear commit message under 50 characters.',
        user: `Describe these changes briefly:
Files: ${stagedFiles.join(', ')}
Diff: ${diff.substring(0, 500)}`
      },
      detailed: {
        system: 'Generate a detailed commit message with a subject line and body.',
        user: `Create a comprehensive commit message:
Files: ${stagedFiles.join(', ')}
Changes: ${diff.substring(0, 1500)}`
      }
    };

    return prompts[style] || prompts.conventional;
  }

  async analyzeCodeQuality(diff) {
    const settings = await this.getSettings();
    
    if (!settings.enabled || !settings.features?.prePushAnalysis) {
      return null;
    }

    try {
      const response = await axios.post(
        `${settings.llmGatewayUrl}/api/chat/completions`,
        {
          model: settings.model,
          messages: [
            {
              role: 'system',
              content: `Analyze this code diff for quality issues. Return JSON:
{
  "risk_level": "low|medium|high",
  "issues": [{"severity": "error|warning", "message": "..."}],
  "suggestions": ["..."],
  "ready_to_push": true/false
}`
            },
            {
              role: 'user',
              content: `Analyze: \n${diff.substring(0, 3000)}`
            }
          ],
          temperature: 0.3,
          max_tokens: 1000
        },
        { timeout: 30000 }
      );

      const content = response.data.choices[0].message.content;
      try {
        return JSON.parse(content);
      } catch {
        return { risk_level: 'unknown', issues: [], suggestions: [], ready_to_push: true };
      }
    } catch (error) {
      console.error('Error analyzing code quality:', error.message);
      return null;
    }
  }

  async summarizePullChanges(pullResult) {
    const settings = await this.getSettings();
    
    if (!settings.enabled || !settings.features?.pullSummaries) {
      return null;
    }

    try {
      const response = await axios.post(
        `${settings.llmGatewayUrl}/api/chat/completions`,
        {
          model: settings.model,
          messages: [
            {
              role: 'system',
              content: 'Summarize git pull changes concisely for the team.'
            },
            {
              role: 'user',
              content: `Summarize: ${JSON.stringify(pullResult)}`
            }
          ],
          temperature: settings.temperature,
          max_tokens: 300
        },
        { timeout: 30000 }
      );

      return response.data.choices[0].message.content.trim();
    } catch (error) {
      console.error('Error summarizing pull changes:', error.message);
      return null;
    }
  }

  async tokenizeText(text, model = null) {
    const settings = await this.getSettings();
    
    if (!settings.enabled || !settings.features?.tokenCounting) {
      return null;
    }

    try {
      const response = await axios.post(
        `${settings.llmGatewayUrl}/api/tokenize`,
        {
          text,
          model: model || settings.model
        },
        { timeout: 10000 }
      );

      return response.data.tokens;
    } catch (error) {
      console.error('Error tokenizing text:', error.message);
      return null;
    }
  }

  async suggestFiles(query, fileList, maxSuggestions = 10) {
    const settings = await this.getSettings();
    
    if (!settings.enabled) {
      return [];
    }

    try {
      const response = await axios.post(
        `${settings.llmGatewayUrl}/api/chat/completions`,
        {
          model: settings.model,
          messages: [
            {
              role: 'system',
              content: `Given a task and file list, suggest relevant files. Return JSON array:
[{"file": "path", "relevance": 0.9, "reason": "..."}]`
            },
            {
              role: 'user',
              content: `Task: "${query}"\nFiles: ${fileList.slice(0, 100).join('\n')}`
            }
          ],
          temperature: 0.5,
          max_tokens: 500
        },
        { timeout: 30000 }
      );

      const content = response.data.choices[0].message.content;
      try {
        const suggestions = JSON.parse(content);
        return suggestions.slice(0, maxSuggestions);
      } catch {
        return [];
      }
    } catch (error) {
      console.error('Error suggesting files:', error.message);
      return [];
    }
  }

  async resolveConflict(conflictContent, context = '') {
    const settings = await this.getSettings();
    
    if (!settings.enabled || !settings.features?.conflictResolution) {
      return null;
    }

    try {
      const response = await axios.post(
        `${settings.llmGatewayUrl}/api/chat/completions`,
        {
          model: settings.model,
          messages: [
            {
              role: 'system',
              content: `Resolve merge conflicts intelligently. Return JSON:
{"resolution": "resolved content", "explanation": "...", "confidence": "high|medium|low"}`
            },
            {
              role: 'user',
              content: `${context ? `Context: ${context}\n` : ''}Conflict:\n${conflictContent}`
            }
          ],
          temperature: 0.3,
          max_tokens: 2000
        },
        { timeout: 30000 }
      );

      const content = response.data.choices[0].message.content;
      try {
        return JSON.parse(content);
      } catch {
        return {
          resolution: content,
          explanation: 'AI suggested resolution',
          confidence: 'medium'
        };
      }
    } catch (error) {
      console.error('Error resolving conflict:', error.message);
      return null;
    }
  }
}

module.exports = new AIService();
