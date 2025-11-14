/**
 * CONVERSATIONS MODULE
 * 
 * Core conversation and message management.
 * Handles creating, updating, and managing conversations and messages.
 * 
 * Features:
 * - Create/read/update/delete conversations
 * - Add messages to conversations
 * - Search and filter conversations
 * - Export conversations
 * 
 * Extension Points:
 * - messageHandlers: Add custom message processors
 * - conversationHooks: Run code on conversation events
 */

const { q } = require('../db');

// Extension registry
const messageHandlers = [];
const conversationHooks = {
  beforeCreate: [],
  afterCreate: [],
  beforeUpdate: [],
  afterUpdate: [],
  beforeDelete: [],
  afterDelete: []
};

/**
 * Module metadata
 */
const version = '1.0.0';
const description = 'Core conversation and message management';
const endpoints = [
  'GET /api/conversations',
  'POST /api/conversations',
  'GET /api/conversations/:id',
  'PUT /api/conversations/:id',
  'DELETE /api/conversations/:id',
  'GET /api/conversations/:id/messages',
  'POST /api/conversations/:id/messages',
  'GET /api/conversations/:id/export'
];

/**
 * Initialize module
 */
async function initialize() {
  // Setup can go here
  return true;
}

// ========== CONVERSATIONS ==========

/**
 * List conversations with filtering
 */
async function listConversations({ 
  limit = 50, 
  archived = false, 
  search = null,
  sortBy = 'updated_at',
  sortOrder = 'DESC'
} = {}) {
  let query = `
    SELECT 
      c.*,
      COUNT(cm.id) as message_count,
      MAX(cm.created_at) as last_message_at,
      pp.name as personality_name,
      (
        SELECT COUNT(*) FROM conversation_branches cb 
        WHERE cb.parent_conversation_id = c.id
      ) as child_branches_count
    FROM conversations c
    LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
    LEFT JOIN personality_profiles pp ON pp.id = c.personality_id
    WHERE c.archived = $1
  `;
  const params = [archived];
  
  if (search) {
    query += ` AND (c.title ILIKE $${params.length + 1} OR c.id ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }
  
  query += `
    GROUP BY c.id, pp.name
    ORDER BY ${sortBy} ${sortOrder}
    LIMIT $${params.length + 1}
  `;
  params.push(Math.min(Number(limit), 200));
  
  const { rows } = await q(query, params);
  return rows;
}

/**
 * Get conversation by ID
 */
async function getConversation(id) {
  const { rows } = await q(`
    SELECT 
      c.*,
      pp.name as personality_name,
      pp.system_prompt as personality_system_prompt,
      (
        SELECT COUNT(*) FROM conversation_messages 
        WHERE conversation_id = c.id
      ) as message_count,
      (
        SELECT COUNT(*) FROM conversation_messages 
        WHERE conversation_id = c.id AND in_context = true
      ) as context_message_count
    FROM conversations c
    LEFT JOIN personality_profiles pp ON pp.id = c.personality_id
    WHERE c.id = $1
  `, [id]);
  
  return rows[0];
}

/**
 * Create new conversation
 */
async function createConversation(conv) {
  // Run before hooks
  for (const hook of conversationHooks.beforeCreate) {
    await hook(conv);
  }
  
  const { rows } = await q(`
    INSERT INTO conversations(
      id, title, system_prompt, model_id, personality_id, 
      parent_branch_id, branch_point_message_id, meta
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
    RETURNING *
  `, [
    conv.id, 
    conv.title || null, 
    conv.system_prompt || null,
    conv.model_id || null,
    conv.personality_id || null,
    conv.parent_branch_id || null,
    conv.branch_point_message_id || null,
    conv.meta || null
  ]);
  
  const created = rows[0];
  
  // Run after hooks
  for (const hook of conversationHooks.afterCreate) {
    await hook(created);
  }
  
  return created;
}

/**
 * Update conversation
 */
async function updateConversation(id, updates) {
  // Run before hooks
  for (const hook of conversationHooks.beforeUpdate) {
    await hook(id, updates);
  }
  
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.title !== undefined) {
    fields.push(`title = $${idx++}`);
    values.push(updates.title);
  }
  if (updates.system_prompt !== undefined) {
    fields.push(`system_prompt = $${idx++}`);
    values.push(updates.system_prompt);
  }
  if (updates.model_id !== undefined) {
    fields.push(`model_id = $${idx++}`);
    values.push(updates.model_id);
  }
  if (updates.personality_id !== undefined) {
    fields.push(`personality_id = $${idx++}`);
    values.push(updates.personality_id);
  }
  if (updates.meta !== undefined) {
    fields.push(`meta = $${idx++}`);
    values.push(updates.meta);
  }
  if (updates.archived !== undefined) {
    fields.push(`archived = $${idx++}`);
    values.push(updates.archived);
  }

  fields.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await q(`
    UPDATE conversations 
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING *
  `, values);
  
  const updated = rows[0];
  
  // Run after hooks
  for (const hook of conversationHooks.afterUpdate) {
    await hook(updated);
  }
  
  return updated;
}

/**
 * Delete conversation
 */
async function deleteConversation(id) {
  // Run before hooks
  for (const hook of conversationHooks.beforeDelete) {
    await hook(id);
  }
  
  await q('DELETE FROM conversations WHERE id=$1', [id]);
  
  // Run after hooks
  for (const hook of conversationHooks.afterDelete) {
    await hook(id);
  }
}

// ========== MESSAGES ==========

/**
 * Get messages for a conversation
 */
async function getConversationMessages(convId, { 
  limit = 100, 
  before = null,
  inContextOnly = false
} = {}) {
  let query = `
    SELECT 
      cm.*,
      sr.data as structured_data,
      sr.validation_status as structured_validation_status,
      os.name as schema_name
    FROM conversation_messages cm
    LEFT JOIN structured_responses sr ON sr.message_id = cm.id
    LEFT JOIN output_schemas os ON os.id = sr.schema_id
    WHERE cm.conversation_id = $1
  `;
  const params = [convId];

  if (inContextOnly) {
    query += ` AND cm.in_context = true`;
  }

  if (before) {
    query += ` AND cm.id < $${params.length + 1}`;
    params.push(before);
  }

  query += ` ORDER BY cm.id DESC LIMIT $${params.length + 1}`;
  params.push(Math.min(Number(limit), 500));

  const { rows } = await q(query, params);
  return rows.reverse(); // Return in chronological order
}

/**
 * Add message to conversation
 */
async function addConversationMessage(msg) {
  // Run message handlers
  for (const handler of messageHandlers) {
    await handler(msg);
  }
  
  const { rows } = await q(`
    INSERT INTO conversation_messages(
      conversation_id, role, content, tokens, cost, 
      in_context, priority, pinned, meta
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
    RETURNING *
  `, [
    msg.conversation_id,
    msg.role,
    msg.content || null,
    msg.tokens || null,
    msg.cost || null,
    msg.in_context !== undefined ? msg.in_context : true,
    msg.priority || 50,
    msg.pinned || false,
    msg.meta || null
  ]);

  // Update conversation updated_at
  await q(
    'UPDATE conversations SET updated_at = now() WHERE id = $1', 
    [msg.conversation_id]
  );
  
  return rows[0];
}

/**
 * Update message
 */
async function updateMessage(messageId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.content !== undefined) {
    fields.push(`content = $${idx++}`);
    values.push(updates.content);
  }
  if (updates.in_context !== undefined) {
    fields.push(`in_context = $${idx++}`);
    values.push(updates.in_context);
  }
  if (updates.priority !== undefined) {
    fields.push(`priority = $${idx++}`);
    values.push(updates.priority);
  }
  if (updates.pinned !== undefined) {
    fields.push(`pinned = $${idx++}`);
    values.push(updates.pinned);
  }
  if (updates.meta !== undefined) {
    fields.push(`meta = $${idx++}`);
    values.push(updates.meta);
  }

  values.push(messageId);

  const { rows } = await q(`
    UPDATE conversation_messages 
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING *
  `, values);
  
  return rows[0];
}

/**
 * Delete message
 */
async function deleteMessage(messageId) {
  await q('DELETE FROM conversation_messages WHERE id=$1', [messageId]);
}

/**
 * Export full conversation
 */
async function exportConversation(id) {
  const conversation = await getConversation(id);
  if (!conversation) {
    throw new Error('Conversation not found');
  }
  
  const messages = await getConversationMessages(id, { limit: 10000 });
  
  return {
    conversation,
    messages,
    exported_at: new Date().toISOString()
  };
}

// ========== EXTENSION POINTS ==========

/**
 * Register a message handler
 * Handler is called before message is saved
 */
function registerMessageHandler(handler) {
  messageHandlers.push(handler);
}

/**
 * Register conversation hooks
 */
function registerConversationHook(event, handler) {
  if (!conversationHooks[event]) {
    throw new Error(`Unknown hook event: ${event}`);
  }
  conversationHooks[event].push(handler);
}

module.exports = {
  // Metadata
  version,
  description,
  endpoints,
  
  // Lifecycle
  initialize,
  
  // Conversations
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  deleteConversation,
  exportConversation,
  
  // Messages
  getConversationMessages,
  addConversationMessage,
  updateMessage,
  deleteMessage,
  
  // Extensions
  registerMessageHandler,
  registerConversationHook
};
