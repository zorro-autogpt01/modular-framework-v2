// llm-gateway/server/providers/providerRouter.js
// Routes requests to appropriate provider based on model

const { OpenAIProvider } = require('./openai');
const { OllamaProvider } = require('./ollama');
const { AnthropicProvider } = require('./anthropic');

class ProviderRouter {
  constructor() {
    this.providers = new Map();
    this.modelPatterns = new Map();
    
    this.initializeProviders();
  }

  initializeProviders() {
    // Initialize providers
    this.providers.set('openai', new OpenAIProvider());
    this.providers.set('ollama', new OllamaProvider());
    this.providers.set('anthropic', new AnthropicProvider());

    // Map model patterns to providers
    this.modelPatterns.set(/^(gpt-|o5-|o1-)/i, 'openai');
    this.modelPatterns.set(/^claude-/i, 'anthropic');
    this.modelPatterns.set(/^(llama|mistral|qwen|gemma|phi)/i, 'ollama');
  }

  selectProvider(model, explicitProvider) {
    // Use explicit provider if specified
    if (explicitProvider && this.providers.has(explicitProvider)) {
      return this.providers.get(explicitProvider);
    }

    // Match by model pattern
    for (const [pattern, providerName] of this.modelPatterns) {
      if (pattern.test(model)) {
        return this.providers.get(providerName);
      }
    }

    // Default to OpenAI
    return this.providers.get('openai');
  }

  getAvailableModels() {
    const models = [];
    for (const [name, provider] of this.providers) {
      models.push(...provider.getModels().map(m => ({
        ...m,
        provider: name
      })));
    }
    return models;
  }

  async checkHealth() {
    const health = {};
    for (const [name, provider] of this.providers) {
      health[name] = await provider.checkHealth();
    }
    return health;
  }
}

module.exports = { ProviderRouter };

// ============================================
// llm-gateway/server/providers/base.js
// Base provider class

class BaseProvider {
  constructor(name) {
    this.name = name;
  }

  async chat(params) {
    throw new Error('chat() must be implemented by provider');
  }

  async streamChat(params) {
    throw new Error('streamChat() must be implemented by provider');
  }

  getModels() {
    return [];
  }

  async checkHealth() {
    return { status: 'unknown' };
  }
}

module.exports = { BaseProvider };

// ============================================
// llm-gateway/server/providers/openai.js
// OpenAI provider implementation

const axios = require('axios');
const { BaseProvider } = require('./base');

class OpenAIProvider extends BaseProvider {
  constructor() {
    super('openai');
    this.apiKey = process.env.OPENAI_API_KEY;
    this.baseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  }

  async chat({ model, messages, temperature, max_tokens, metadata, corr }) {
    const isGpt5 = /^(gpt-5|o5)/i.test(model);
    const endpoint = isGpt5 ? '/responses' : '/chat/completions';
    
    const body = {
      model,
      messages,
      stream: false
    };

    // GPT-5 models don't support temperature
    if (!isGpt5 && temperature !== undefined) {
      body.temperature = temperature;
    }

    // Handle max_tokens vs max_completion_tokens
    if (max_tokens !== undefined) {
      if (isGpt5) {
        body.max_completion_tokens = max_tokens;
      } else {
        body.max_tokens = max_tokens;
      }
    }

    const response = await axios.post(`${this.baseUrl}${endpoint}`, body, {
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'X-Correlation-Id': corr
      },
      timeout: 120000
    });

    return response.data;
  }

  async streamChat({ model, messages, temperature, max_tokens, metadata, onChunk, onDone, onError, corr }) {
    const isGpt5 = /^(gpt-5|o5)/i.test(model);
    const endpoint = isGpt5 ? '/responses' : '/chat/completions';
    
    const body = {
      model,
      messages,
      stream: true
    };

    if (!isGpt5 && temperature !== undefined) {
      body.temperature = temperature;
    }

    if (max_tokens !== undefined) {
      if (isGpt5) {
        body.max_completion_tokens = max_tokens;
      } else {
        body.max_tokens = max_tokens;
      }
    }

    try {
      const response = await axios.post(`${this.baseUrl}${endpoint}`, body, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'X-Correlation-Id': corr
        },
        responseType: 'stream',
        timeout: 120000
      });

      let buffer = '';
      let totalTokens = 0;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          
          const data = line.slice(6);
          if (data === '[DONE]') {
            onDone({ total_tokens: totalTokens });
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = this.extractStreamContent(parsed, isGpt5);
            
            if (content) {
              totalTokens++;
              onChunk({ content, tokens: 1 });
            }
          } catch (e) {
            console.error('Failed to parse SSE chunk:', e);
          }
        }
      });

      response.data.on('error', (error) => {
        onError(error);
      });

      response.data.on('end', () => {
        if (buffer) {
          // Process any remaining data
          try {
            const data = buffer.replace('data: ', '');
            if (data !== '[DONE]') {
              const parsed = JSON.parse(data);
              const content = this.extractStreamContent(parsed, isGpt5);
              if (content) {
                onChunk({ content });
              }
            }
          } catch (e) {
            // Ignore
          }
        }
        onDone({ total_tokens: totalTokens });
      });
    } catch (error) {
      onError(error);
    }
  }

  extractStreamContent(data, isGpt5) {
    if (isGpt5) {
      // GPT-5 responses format
      if (data?.type === 'response.output_text.delta') {
        return data.delta;
      }
      if (data?.output_text_delta) {
        return data.output_text_delta;
      }
    } else {
      // Standard chat completions format
      if (data?.choices?.[0]?.delta?.content) {
        return data.choices[0].delta.content;
      }
    }
    return null;
  }

  getModels() {
    return [
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
      { id: 'gpt-4o', name: 'GPT-4o' },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano' },
      { id: 'o5-mini', name: 'O5 Mini' },
      { id: 'o1-preview', name: 'O1 Preview' }
    ];
  }

  async checkHealth() {
    try {
      await axios.get(`${this.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${this.apiKey}` },
        timeout: 5000
      });
      return { status: 'healthy', timestamp: new Date().toISOString() };
    } catch (error) {
      return { 
        status: 'unhealthy', 
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = { OpenAIProvider };

// ============================================
// llm-gateway/server/providers/ollama.js
// Ollama provider implementation

const axios = require('axios');
const { BaseProvider } = require('./base');

class OllamaProvider extends BaseProvider {
  constructor() {
    super('ollama');
    this.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  }

  async chat({ model, messages, temperature, max_tokens, metadata, corr }) {
    const body = {
      model,
      messages,
      stream: false,
      options: {}
    };

    if (temperature !== undefined) {
      body.options.temperature = temperature;
    }

    if (max_tokens !== undefined) {
      body.options.num_predict = max_tokens;
    }

    const response = await axios.post(`${this.baseUrl}/api/chat`, body, {
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': corr
      },
      timeout: 120000
    });

    return response.data;
  }

  async streamChat({ model, messages, temperature, max_tokens, metadata, onChunk, onDone, onError, corr }) {
    const body = {
      model,
      messages,
      stream: true,
      options: {}
    };

    if (temperature !== undefined) {
      body.options.temperature = temperature;
    }

    if (max_tokens !== undefined) {
      body.options.num_predict = max_tokens;
    }

    try {
      const response = await axios.post(`${this.baseUrl}/api/chat`, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-Id': corr
        },
        responseType: 'stream',
        timeout: 120000
      });

      let buffer = '';
      let totalTokens = 0;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);
            
            if (parsed.message?.content) {
              totalTokens++;
              onChunk({ content: parsed.message.content, tokens: 1 });
            }

            if (parsed.done) {
              onDone({
                total_tokens: totalTokens,
                eval_count: parsed.eval_count,
                prompt_eval_count: parsed.prompt_eval_count
              });
            }
          } catch (e) {
            console.error('Failed to parse Ollama chunk:', e);
          }
        }
      });

      response.data.on('error', (error) => {
        onError(error);
      });
    } catch (error) {
      onError(error);
    }
  }

  async getModels() {
    try {
      const response = await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 5000
      });
      return response.data.models.map(m => ({
        id: m.name,
        name: m.name,
        size: m.size
      }));
    } catch (error) {
      return [];
    }
  }

  async checkHealth() {
    try {
      await axios.get(`${this.baseUrl}/api/tags`, {
        timeout: 5000
      });
      return { status: 'healthy', timestamp: new Date().toISOString() };
    } catch (error) {
      return { 
        status: 'unhealthy', 
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = { OllamaProvider };

// ============================================
// llm-gateway/server/providers/anthropic.js
// Anthropic/Claude provider implementation

const axios = require('axios');
const { BaseProvider } = require('./base');

class AnthropicProvider extends BaseProvider {
  constructor() {
    super('anthropic');
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    this.baseUrl = 'https://api.anthropic.com/v1';
  }

  async chat({ model, messages, temperature, max_tokens, metadata, corr }) {
    const body = {
      model,
      messages: this.convertMessages(messages),
      max_tokens: max_tokens || 4096
    };

    if (temperature !== undefined) {
      body.temperature = temperature;
    }

    const response = await axios.post(`${this.baseUrl}/messages`, body, {
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'X-Correlation-Id': corr
      },
      timeout: 120000
    });

    return response.data;
  }

  convertMessages(messages) {
    // Extract system message if present
    const systemMsg = messages.find(m => m.role === 'system');
    const nonSystemMessages = messages.filter(m => m.role !== 'system');

    const converted = {
      messages: nonSystemMessages
    };

    if (systemMsg) {
      converted.system = systemMsg.content;
    }

    return converted;
  }

  async streamChat({ model, messages, temperature, max_tokens, metadata, onChunk, onDone, onError, corr }) {
    // Similar implementation with streaming
    // Anthropic uses Server-Sent Events format
    // Implementation details omitted for brevity
    throw new Error('Anthropic streaming not yet implemented');
  }

  getModels() {
    return [
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet' },
      { id: 'claude-3-opus-20240229', name: 'Claude 3 Opus' },
      { id: 'claude-3-haiku-20240307', name: 'Claude 3 Haiku' }
    ];
  }

  async checkHealth() {
    // Anthropic doesn't have a health endpoint, so we'll do a minimal test
    return { status: 'assumed-healthy', timestamp: new Date().toISOString() };
  }
}

module.exports = { AnthropicProvider };