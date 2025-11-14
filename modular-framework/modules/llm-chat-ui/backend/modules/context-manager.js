/**
 * CONTEXT MANAGER MODULE
 * 
 * Intelligent context window management and optimization.
 * Handles token budgets, message prioritization, and context compression.
 * 
 * Features:
 * - Real-time token tracking
 * - Multiple optimization strategies
 * - Message prioritization
 * - Context snapshots
 * 
 * Extension Points:
 * - compressionAlgorithms: Custom compression strategies
 * - priorityCalculators: Custom priority scoring
 */

const { q } = require('../db');
const { getConversationMessages, updateMessage } = require('./conversations');

// Extension registries
const compressionAlgorithms = new Map();
const priorityCalculators = new Map();

/**
 * Module metadata
 */
const version = '1.0.0';
const description = 'Context window and token budget management';
const endpoints = [
  'GET /api/context/:conversationId',
  'POST /api/context/:conversationId/optimize',
  'POST /api/context/:conversationId/snapshot',
  'PUT /api/context/messages/:messageId/priority',
  'GET /api/context/strategies'
];

/**
 * Initialize module with default strategies
 */
async function initialize() {
  registerCompressionAlgorithm('sliding_window', slidingWindowCompression);
  registerCompressionAlgorithm('priority_based', priorityBasedCompression);
  registerCompressionAlgorithm('semantic', semanticCompression);
  
  registerPriorityCalculator('recency', recencyPriorityCalculator);
  registerPriorityCalculator('manual', manualPriorityCalculator);
  registerPriorityCalculator('semantic_importance', semanticImportanceCalculator);
  
  return true;
}

// ========== CONTEXT ANALYSIS ==========

/**
 * Get current context state for a conversation
 */
async function getContextState(conversationId, options = {}) {
  const messages = await getConversationMessages(conversationId, {
    limit: 1000,
    inContextOnly: options.inContextOnly || false
  });

  const contextMessages = messages.filter(m => m.in_context);
  const totalTokens = messages.reduce((sum, m) => sum + (m.tokens || 0), 0);
  const contextTokens = contextMessages.reduce((sum, m) => sum + (m.tokens || 0), 0);
  
  const messagesByRole = messages.reduce((acc, m) => {
    acc[m.role] = (acc[m.role] || 0) + 1;
    return acc;
  }, {});

  const pinnedMessages = messages.filter(m => m.pinned);
  const priorityDistribution = messages.reduce((acc, m) => {
    const bucket = Math.floor((m.priority || 50) / 10) * 10;
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {});

  return {
    conversation_id: conversationId,
    total_messages: messages.length,
    context_messages: contextMessages.length,
    excluded_messages: messages.length - contextMessages.length,
    total_tokens: totalTokens,
    context_tokens: contextTokens,
    pinned_messages: pinnedMessages.length,
    messages_by_role: messagesByRole,
    priority_distribution: priorityDistribution,
    messages: messages.map(m => ({
      id: m.id,
      role: m.role,
      tokens: m.tokens,
      in_context: m.in_context,
      priority: m.priority,
      pinned: m.pinned,
      content_preview: m.content ? m.content.substring(0, 100) : null
    }))
  };
}

/**
 * Calculate tokens for conversation context
 */
function estimateTokens(text) {
  // Simple estimation: ~4 chars per token
  // In production, use actual tokenizer (tiktoken, etc.)
  return Math.ceil((text || '').length / 4);
}

/**
 * Get effective context that would be sent to LLM
 */
async function getEffectiveContext(conversationId, maxTokens = null) {
  const messages = await getConversationMessages(conversationId, {
    limit: 1000,
    inContextOnly: true
  });

  let effectiveMessages = messages;
  let totalTokens = messages.reduce((sum, m) => sum + (m.tokens || 0), 0);

  // If maxTokens specified and exceeded, apply optimization
  if (maxTokens && totalTokens > maxTokens) {
    effectiveMessages = await optimizeContext(conversationId, {
      maxTokens,
      strategy: 'priority_based',
      dryRun: true
    });
    totalTokens = effectiveMessages.reduce((sum, m) => sum + (m.tokens || 0), 0);
  }

  return {
    messages: effectiveMessages,
    total_tokens: totalTokens,
    max_tokens: maxTokens,
    within_budget: !maxTokens || totalTokens <= maxTokens
  };
}

// ========== CONTEXT OPTIMIZATION ==========

/**
 * Optimize conversation context
 */
async function optimizeContext(conversationId, {
  maxTokens = 8000,
  strategy = 'priority_based',
  keepSystem = true,
  keepPinned = true,
  dryRun = false
} = {}) {
  const messages = await getConversationMessages(conversationId, { limit: 1000 });
  
  const algorithm = compressionAlgorithms.get(strategy);
  if (!algorithm) {
    throw new Error(`Unknown compression strategy: ${strategy}`);
  }

  const optimizedMessages = await algorithm({
    messages,
    maxTokens,
    keepSystem,
    keepPinned
  });

  if (!dryRun) {
    // Update database: mark messages as in/out of context
    const inContextIds = new Set(optimizedMessages.map(m => m.id));
    
    for (const msg of messages) {
      const shouldBeInContext = inContextIds.has(msg.id);
      if (msg.in_context !== shouldBeInContext) {
        await updateMessage(msg.id, { in_context: shouldBeInContext });
      }
    }

    // Create snapshot
    await createContextSnapshot(conversationId, {
      strategy,
      message_ids: Array.from(inContextIds),
      total_tokens: optimizedMessages.reduce((sum, m) => sum + (m.tokens || 0), 0)
    });
  }

  return optimizedMessages;
}

/**
 * Update message priority
 */
async function updateMessagePriority(messageId, priority) {
  if (priority < 0 || priority > 100) {
    throw new Error('Priority must be between 0 and 100');
  }
  
  return updateMessage(messageId, { priority });
}

/**
 * Pin/unpin message (always keep in context)
 */
async function toggleMessagePin(messageId, pinned) {
  const updated = await updateMessage(messageId, { pinned });
  
  // If pinning, ensure it's in context
  if (pinned) {
    await updateMessage(messageId, { in_context: true });
  }
  
  return updated;
}

// ========== CONTEXT SNAPSHOTS ==========

/**
 * Create context snapshot
 */
async function createContextSnapshot(conversationId, {
  strategy,
  message_ids,
  total_tokens,
  name = null
}) {
  const { rows } = await q(`
    INSERT INTO context_snapshots(
      conversation_id, snapshot_name, message_ids, 
      total_tokens, strategy_used
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [
    conversationId,
    name || `Auto-${strategy}-${Date.now()}`,
    message_ids,
    total_tokens,
    strategy
  ]);

  return rows[0];
}

/**
 * Restore from snapshot
 */
async function restoreFromSnapshot(snapshotId) {
  const { rows } = await q(
    'SELECT * FROM context_snapshots WHERE id = $1',
    [snapshotId]
  );
  
  if (!rows[0]) {
    throw new Error('Snapshot not found');
  }

  const snapshot = rows[0];
  const messages = await getConversationMessages(snapshot.conversation_id, { limit: 1000 });
  
  const inContextIds = new Set(snapshot.message_ids);
  
  for (const msg of messages) {
    const shouldBeInContext = inContextIds.has(msg.id);
    if (msg.in_context !== shouldBeInContext) {
      await updateMessage(msg.id, { in_context: shouldBeInContext });
    }
  }

  return snapshot;
}

/**
 * List snapshots for conversation
 */
async function listContextSnapshots(conversationId) {
  const { rows } = await q(`
    SELECT * FROM context_snapshots
    WHERE conversation_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  `, [conversationId]);

  return rows;
}

// ========== DEFAULT COMPRESSION ALGORITHMS ==========

/**
 * Sliding window: Keep most recent N messages
 */
async function slidingWindowCompression({ messages, maxTokens, keepSystem, keepPinned }) {
  const result = [];
  let tokens = 0;

  // Always keep system messages if specified
  if (keepSystem) {
    const systemMsgs = messages.filter(m => m.role === 'system');
    result.push(...systemMsgs);
    tokens += systemMsgs.reduce((sum, m) => sum + (m.tokens || 0), 0);
  }

  // Always keep pinned messages if specified
  if (keepPinned) {
    const pinnedMsgs = messages.filter(m => m.pinned && m.role !== 'system');
    result.push(...pinnedMsgs);
    tokens += pinnedMsgs.reduce((sum, m) => sum + (m.tokens || 0), 0);
  }

  // Add recent messages until budget exceeded
  const remainingMsgs = messages
    .filter(m => 
      (!keepSystem || m.role !== 'system') && 
      (!keepPinned || !m.pinned)
    )
    .reverse(); // Most recent first

  for (const msg of remainingMsgs) {
    const msgTokens = msg.tokens || 0;
    if (tokens + msgTokens <= maxTokens) {
      result.push(msg);
      tokens += msgTokens;
    } else {
      break;
    }
  }

  return result.sort((a, b) => a.id - b.id); // Return in chronological order
}

/**
 * Priority-based: Keep highest priority messages
 */
async function priorityBasedCompression({ messages, maxTokens, keepSystem, keepPinned }) {
  const result = [];
  let tokens = 0;

  // Always keep system and pinned
  const alwaysKeep = messages.filter(m => 
    (keepSystem && m.role === 'system') || 
    (keepPinned && m.pinned)
  );
  result.push(...alwaysKeep);
  tokens += alwaysKeep.reduce((sum, m) => sum + (m.tokens || 0), 0);

  // Sort remaining by priority (highest first)
  const sortedMsgs = messages
    .filter(m => !alwaysKeep.includes(m))
    .sort((a, b) => (b.priority || 50) - (a.priority || 50));

  for (const msg of sortedMsgs) {
    const msgTokens = msg.tokens || 0;
    if (tokens + msgTokens <= maxTokens) {
      result.push(msg);
      tokens += msgTokens;
    }
  }

  return result.sort((a, b) => a.id - b.id);
}

/**
 * Semantic compression: Keep semantically important messages
 * (Placeholder - would need embeddings/similarity in production)
 */
async function semanticCompression({ messages, maxTokens, keepSystem, keepPinned }) {
  // For now, fall back to priority-based
  // In production, this would use embeddings to determine semantic importance
  return priorityBasedCompression({ messages, maxTokens, keepSystem, keepPinned });
}

// ========== PRIORITY CALCULATORS ==========

/**
 * Recency-based priority: More recent = higher priority
 */
function recencyPriorityCalculator(message, index, allMessages) {
  const position = index / allMessages.length;
  return Math.floor(position * 100); // 0-100 based on position
}

/**
 * Manual priority: Use user-set priority
 */
function manualPriorityCalculator(message) {
  return message.priority || 50;
}

/**
 * Semantic importance calculator (placeholder)
 */
function semanticImportanceCalculator(message, index, allMessages) {
  // Would use embeddings/analysis in production
  return manualPriorityCalculator(message);
}

/**
 * Auto-assign priorities to messages
 */
async function autoAssignPriorities(conversationId, calculator = 'recency') {
  const calc = priorityCalculators.get(calculator);
  if (!calc) {
    throw new Error(`Unknown priority calculator: ${calculator}`);
  }

  const messages = await getConversationMessages(conversationId, { limit: 1000 });
  
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const priority = calc(msg, i, messages);
    
    if (msg.priority !== priority) {
      await updateMessage(msg.id, { priority });
    }
  }

  return messages.length;
}

// ========== EXTENSION POINTS ==========

function registerCompressionAlgorithm(name, handler) {
  compressionAlgorithms.set(name, handler);
}

function registerPriorityCalculator(name, handler) {
  priorityCalculators.set(name, handler);
}

/**
 * Get available strategies
 */
function getAvailableStrategies() {
  return {
    compression: Array.from(compressionAlgorithms.keys()),
    priority: Array.from(priorityCalculators.keys())
  };
}

module.exports = {
  // Metadata
  version,
  description,
  endpoints,
  
  // Lifecycle
  initialize,
  
  // Analysis
  getContextState,
  getEffectiveContext,
  estimateTokens,
  
  // Optimization
  optimizeContext,
  updateMessagePriority,
  toggleMessagePin,
  autoAssignPriorities,
  
  // Snapshots
  createContextSnapshot,
  restoreFromSnapshot,
  listContextSnapshots,
  
  // Extensions
  registerCompressionAlgorithm,
  registerPriorityCalculator,
  getAvailableStrategies
};
