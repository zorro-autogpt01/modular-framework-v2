// llm-gateway/server/util/sseManager.js
// Centralized SSE handling for all streaming responses

class SSEManager {
  constructor(res, correlationId) {
    this.res = res;
    this.correlationId = correlationId;
    this.messageId = 0;
    this.isClosed = false;
    this.totalTokens = 0;
  }

  init() {
    // Set SSE headers
    this.res.setHeader('Content-Type', 'text/event-stream');
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('Connection', 'keep-alive');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.setHeader('X-Correlation-Id', this.correlationId);

    // Handle client disconnect
    this.res.on('close', () => {
      this.isClosed = true;
      console.log(`SSE connection closed: ${this.correlationId}`);
    });

    // Send initial ping
    this.send({ type: 'ping', timestamp: Date.now() });
  }

  send(data) {
    if (this.isClosed) return;

    const message = `data: ${JSON.stringify(data)}\n\n`;
    this.res.write(message);
    this.messageId++;
  }

  sendChunk(chunk) {
    if (this.isClosed) return;

    // Normalize chunk format
    const normalized = {
      id: `msg_${this.messageId}`,
      type: 'delta',
      content: chunk.content || chunk.delta || chunk.text || '',
      metadata: {
        correlation_id: this.correlationId,
        timestamp: Date.now()
      }
    };

    if (chunk.tokens) {
      this.totalTokens += chunk.tokens;
      normalized.metadata.tokens = chunk.tokens;
    }

    this.send(normalized);
  }

  complete(usage) {
    if (this.isClosed) return;

    this.send({
      type: 'done',
      usage: usage || { total_tokens: this.totalTokens },
      metadata: {
        correlation_id: this.correlationId,
        timestamp: Date.now()
      }
    });

    this.res.end();
  }

  error(error) {
    if (this.isClosed) return;

    this.send({
      type: 'error',
      error: {
        message: error.message || 'Unknown error',
        code: error.code || 'UNKNOWN_ERROR'
      },
      metadata: {
        correlation_id: this.correlationId,
        timestamp: Date.now()
      }
    });

    this.res.end();
  }
}

module.exports = { SSEManager };

// ============================================
// llm-gateway/server/util/responseNormalizer.js
// Normalize responses from all providers to consistent format

function normalizeResponse(data, model) {
  // Already normalized
  if (data.__normalized) {
    return data;
  }

  let content = '';
  let usage = null;
  let metadata = {};

  // Extract content from various formats
  content = extractContent(data);
  usage = extractUsage(data);
  metadata = extractMetadata(data, model);

  return {
    content,
    usage,
    metadata,
    model,
    __normalized: true
  };
}

function extractContent(data) {
  if (typeof data === 'string') return data;

  // Direct content field
  if (data?.content && typeof data.content === 'string') {
    return data.content;
  }

  // OpenAI Chat Completions format
  if (data?.choices?.[0]?.message?.content) {
    return data.choices[0].message.content;
  }

  // OpenAI Responses format (GPT-5)
  if (Array.isArray(data?.output_text)) {
    if (typeof data.output_text[0] === 'string') {
      return data.output_text.join('');
    }
    if (data.output_text[0]?.content) {
      return data.output_text.map(item => item.content || '').join('');
    }
  }

  // Nested output structure (GPT-5 alternative format)
  if (Array.isArray(data?.output)) {
    const message = data.output.find(item => item?.type === 'message');
    if (message) {
      if (Array.isArray(message.content)) {
        const textContent = message.content.find(p => p?.type === 'text');
        if (textContent?.text) return textContent.text;
        
        const outputText = message.content.find(p => p?.type === 'output_text');
        if (outputText?.text) return outputText.text;
        
        // Try first item
        if (message.content[0]?.text) return message.content[0].text;
        if (message.content[0]?.content) return message.content[0].content;
      } else if (typeof message.content === 'string') {
        return message.content;
      }
    }
  }

  // Ollama format
  if (data?.message?.content) {
    return data.message.content;
  }

  // Claude/Anthropic format
  if (data?.content?.[0]?.text) {
    return data.content[0].text;
  }

  // Raw text field
  if (data?.text) {
    return data.text;
  }

  // Last resort - stringify if object
  if (typeof data === 'object') {
    console.warn('Unable to extract content, stringifying response');
    return JSON.stringify(data);
  }

  return '';
}

function extractUsage(data) {
  // Direct usage field
  if (data?.usage) {
    return normalizeUsage(data.usage);
  }

  // OpenAI format
  if (data?.usage_metadata) {
    return normalizeUsage(data.usage_metadata);
  }

  // Anthropic format
  if (data?.usage) {
    return normalizeUsage(data.usage);
  }

  // Try to find in nested structures
  if (data?.metadata?.usage) {
    return normalizeUsage(data.metadata.usage);
  }

  return null;
}

function normalizeUsage(usage) {
  if (!usage) return null;

  return {
    prompt_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    completion_tokens: usage.completion_tokens || usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 
                  (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) ||
                  (usage.input_tokens || 0) + (usage.output_tokens || 0)
  };
}

function extractMetadata(data, model) {
  const metadata = {
    model: model || data?.model || data?.model_name,
    timestamp: new Date().toISOString()
  };

  // Add provider info if available
  if (data?.provider) {
    metadata.provider = data.provider;
  }

  // Add response ID if available
  if (data?.id) {
    metadata.response_id = data.id;
  }

  // Add reasoning tokens for GPT-5
  if (data?.usage?.reasoning_tokens) {
    metadata.reasoning_tokens = data.usage.reasoning_tokens;
  }

  return metadata;
}

module.exports = { normalizeResponse, extractContent, extractUsage };

// ============================================
// llm-gateway/server/util/errorNormalizer.js
// Normalize errors from all providers

function normalizeError(error) {
  const normalized = {
    error: {
      message: 'An error occurred',
      type: 'unknown_error',
      code: 'UNKNOWN'
    },
    status: 500
  };

  // Extract error message
  if (error?.message) {
    normalized.error.message = error.message;
  } else if (typeof error === 'string') {
    normalized.error.message = error;
  }

  // Extract status code
  if (error?.response?.status) {
    normalized.status = error.response.status;
  } else if (error?.status) {
    normalized.status = error.status;
  } else if (error?.statusCode) {
    normalized.status = error.statusCode;
  }

  // Extract error type/code
  if (error?.response?.data?.error?.type) {
    normalized.error.type = error.response.data.error.type;
  } else if (error?.type) {
    normalized.error.type = error.type;
  } else if (error?.code) {
    normalized.error.code = error.code;
  }

  // Map common errors
  if (normalized.status === 429) {
    normalized.error.type = 'rate_limit_exceeded';
    normalized.error.code = 'RATE_LIMIT';
  } else if (normalized.status === 401) {
    normalized.error.type = 'authentication_error';
    normalized.error.code = 'AUTH_FAILED';
  } else if (normalized.status === 404) {
    normalized.error.type = 'not_found';
    normalized.error.code = 'NOT_FOUND';
  } else if (normalized.status === 400) {
    normalized.error.type = 'invalid_request';
    normalized.error.code = 'INVALID_REQUEST';
  }

  // Add details if available
  if (error?.response?.data) {
    normalized.error.details = error.response.data;
  }

  return normalized;
}

module.exports = { normalizeError };