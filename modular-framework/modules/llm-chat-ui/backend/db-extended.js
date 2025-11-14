// Extended database functions for LLM Chat UI
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'llm_gateway',
  max: 10
});

pool.on('connect', (client) => client.query(`SET application_name = 'llm-chat-ui'`).catch(()=>{}));

async function q(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

// ========== Conversation Goals ==========

async function getConversationGoal(conversationId) {
  const { rows } = await q(
    'SELECT * FROM conversation_goals WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 1',
    [conversationId]
  );
  return rows[0];
}

async function createConversationGoal(goal) {
  const { rows } = await q(
    `INSERT INTO conversation_goals(conversation_id, goal_text, goal_type, success_criteria, constraints, progress)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [goal.conversation_id, goal.goal_text, goal.goal_type || null, 
     goal.success_criteria || null, goal.constraints || null, goal.progress || 0]
  );
  return rows[0];
}

async function updateConversationGoal(goalId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.goal_text !== undefined) {
    fields.push(`goal_text = $${idx++}`);
    values.push(updates.goal_text);
  }
  if (updates.goal_type !== undefined) {
    fields.push(`goal_type = $${idx++}`);
    values.push(updates.goal_type);
  }
  if (updates.success_criteria !== undefined) {
    fields.push(`success_criteria = $${idx++}`);
    values.push(updates.success_criteria);
  }
  if (updates.constraints !== undefined) {
    fields.push(`constraints = $${idx++}`);
    values.push(updates.constraints);
  }
  if (updates.progress !== undefined) {
    fields.push(`progress = $${idx++}`);
    values.push(updates.progress);
  }
  if (updates.completed !== undefined) {
    fields.push(`completed = $${idx++}`);
    values.push(updates.completed);
  }

  fields.push(`updated_at = now()`);
  values.push(goalId);

  const { rows } = await q(
    `UPDATE conversation_goals SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0];
}

// ========== Conversation Branches ==========

async function createBranch(branch) {
  const { rows } = await q(
    `INSERT INTO conversation_branches(id, conversation_id, parent_branch_id, branch_point_message_id, name, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [branch.id, branch.conversation_id, branch.parent_branch_id || null,
     branch.branch_point_message_id || null, branch.name || null, branch.description || null]
  );
  
  // Increment branch count
  await q('UPDATE conversations SET branch_count = branch_count + 1 WHERE id = $1', [branch.conversation_id]);
  
  return rows[0];
}

async function getBranches(conversationId) {
  const { rows } = await q(
    'SELECT * FROM conversation_branches WHERE conversation_id = $1 ORDER BY created_at',
    [conversationId]
  );
  return rows;
}

async function getBranch(branchId) {
  const { rows } = await q('SELECT * FROM conversation_branches WHERE id = $1', [branchId]);
  return rows[0];
}

async function setActiveBranch(conversationId, branchId) {
  // Deactivate all branches for this conversation
  await q('UPDATE conversation_branches SET is_active = false WHERE conversation_id = $1', [conversationId]);
  
  // Activate the selected branch
  await q('UPDATE conversation_branches SET is_active = true WHERE id = $1', [branchId]);
  
  // Update conversation
  await q('UPDATE conversations SET active_branch_id = $1, updated_at = now() WHERE id = $2', 
    [branchId, conversationId]);
}

async function updateBranch(branchId, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(updates.name);
  }
  if (updates.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(updates.description);
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = now()`);
  values.push(branchId);

  const { rows } = await q(
    `UPDATE conversation_branches SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0];
}

async function deleteBranch(branchId) {
  // Get child branches
  const { rows: children } = await q(
    'SELECT id FROM conversation_branches WHERE parent_branch_id = $1',
    [branchId]
  );
  
  // Recursively delete children
  for (const child of children) {
    await deleteBranch(child.id);
  }
  
  // Delete the branch (messages will cascade)
  await q('DELETE FROM conversation_branches WHERE id = $1', [branchId]);
}

async function getBranchMessages(branchId, options = {}) {
  const { limit = 100, before = null } = options;
  
  let query = `
    SELECT cm.*, mm.is_pinned, mm.priority_level, mm.rating, mm.in_context
    FROM conversation_messages cm
    LEFT JOIN message_metadata mm ON mm.message_id = cm.id
    WHERE cm.branch_id = $1
  `;
  const params = [branchId];

  if (before) {
    query += ` AND cm.id < $2`;
    params.push(before);
  }

  query += ` ORDER BY cm.id DESC LIMIT $${params.length + 1}`;
  params.push(Math.min(Number(limit), 500));

  const { rows } = await q(query, params);
  return rows.reverse();
}

// ========== Message Metadata ==========

async function getMessageMetadata(messageId) {
  const { rows } = await q('SELECT * FROM message_metadata WHERE message_id = $1', [messageId]);
  return rows[0];
}

async function upsertMessageMetadata(messageId, metadata) {
  const { rows } = await q(`
    INSERT INTO message_metadata(message_id, is_pinned, priority_level, rating, tokens_actual, in_context, summary)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (message_id) DO UPDATE SET
      is_pinned = COALESCE($2, message_metadata.is_pinned),
      priority_level = COALESCE($3, message_metadata.priority_level),
      rating = COALESCE($4, message_metadata.rating),
      tokens_actual = COALESCE($5, message_metadata.tokens_actual),
      in_context = COALESCE($6, message_metadata.in_context),
      summary = COALESCE($7, message_metadata.summary),
      updated_at = now()
    RETURNING *`,
    [messageId, metadata.is_pinned, metadata.priority_level, metadata.rating,
     metadata.tokens_actual, metadata.in_context, metadata.summary]
  );
  return rows[0];
}

// ========== Personality Profiles ==========

async function listPersonalities() {
  const { rows } = await q(
    'SELECT * FROM personality_profiles ORDER BY is_builtin DESC, usage_count DESC, name'
  );
  return rows;
}

async function getPersonality(id) {
  const { rows } = await q('SELECT * FROM personality_profiles WHERE id = $1', [id]);
  return rows[0];
}

async function createPersonality(profile) {
  const { rows } = await q(`
    INSERT INTO personality_profiles(name, description, system_prompt, model_preference, 
                                     temperature, max_tokens, response_style, tags, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [profile.name, profile.description || null, profile.system_prompt,
     profile.model_preference || null, profile.temperature || 0.7,
     profile.max_tokens || 2000, profile.response_style || null,
     profile.tags || null, profile.created_by || null]
  );
  return rows[0];
}

async function updatePersonality(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  const allowedFields = ['name', 'description', 'system_prompt', 'model_preference', 
                        'temperature', 'max_tokens', 'response_style', 'tags'];
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = $${idx++}`);
      values.push(updates[field]);
    }
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await q(
    `UPDATE personality_profiles SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0];
}

async function deletePersonality(id) {
  await q('DELETE FROM personality_profiles WHERE id = $1 AND is_builtin = false', [id]);
}

async function incrementPersonalityUsage(id) {
  await q('UPDATE personality_profiles SET usage_count = usage_count + 1 WHERE id = $1', [id]);
}

// ========== Output Schemas ==========

async function listSchemas(options = {}) {
  const { category = null, tags = null } = options;
  
  let query = 'SELECT * FROM output_schemas WHERE 1=1';
  const params = [];
  let idx = 1;

  if (category) {
    query += ` AND category = $${idx++}`;
    params.push(category);
  }

  if (tags && tags.length > 0) {
    query += ` AND tags && $${idx++}`;
    params.push(tags);
  }

  query += ' ORDER BY is_public DESC, usage_count DESC, name';

  const { rows } = await q(query, params);
  return rows;
}

async function getSchema(id) {
  const { rows } = await q('SELECT * FROM output_schemas WHERE id = $1', [id]);
  return rows[0];
}

async function createSchema(schema) {
  const { rows } = await q(`
    INSERT INTO output_schemas(name, description, schema_definition, category, tags, 
                               validation_mode, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [schema.name, schema.description || null, schema.schema_definition,
     schema.category || null, schema.tags || null, 
     schema.validation_mode || 'strict', schema.created_by || null]
  );
  return rows[0];
}

async function updateSchema(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  const allowedFields = ['name', 'description', 'schema_definition', 'category', 
                        'tags', 'validation_mode'];
  
  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = $${idx++}`);
      values.push(updates[field]);
    }
  }

  if (fields.length === 0) return null;

  fields.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await q(
    `UPDATE output_schemas SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  return rows[0];
}

async function deleteSchema(id) {
  await q('DELETE FROM output_schemas WHERE id = $1 AND is_public = false', [id]);
}

async function incrementSchemaUsage(id) {
  await q('UPDATE output_schemas SET usage_count = usage_count + 1 WHERE id = $1', [id]);
}

async function saveStructuredResponse(messageId, schemaId, data, validationStatus) {
  const { rows } = await q(`
    INSERT INTO structured_responses(message_id, schema_id, data, validation_status)
    VALUES ($1, $2, $3, $4) RETURNING *`,
    [messageId, schemaId, data, validationStatus]
  );
  return rows[0];
}

// ========== Advisor Suggestions ==========

async function saveAdvisorSuggestion(suggestion) {
  const { rows } = await q(`
    INSERT INTO advisor_suggestions(conversation_id, goal_id, suggestion_type, suggestions, selected_index, message_id)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [suggestion.conversation_id, suggestion.goal_id || null, suggestion.suggestion_type,
     suggestion.suggestions, suggestion.selected_index || null, suggestion.message_id || null]
  );
  return rows[0];
}

async function getAdvisorSuggestions(conversationId, limit = 10) {
  const { rows } = await q(
    'SELECT * FROM advisor_suggestions WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2',
    [conversationId, limit]
  );
  return rows;
}

// ========== Smart Actions ==========

async function listSmartActions(category = null) {
  let query = 'SELECT * FROM smart_actions WHERE 1=1';
  const params = [];

  if (category) {
    query += ' AND category = $1';
    params.push(category);
  }

  query += ' ORDER BY is_builtin DESC, order_index, usage_count DESC, name';

  const { rows } = await q(query, params);
  return rows;
}

async function getSmartAction(id) {
  const { rows } = await q('SELECT * FROM smart_actions WHERE id = $1', [id]);
  return rows[0];
}

async function incrementActionUsage(id) {
  await q('UPDATE smart_actions SET usage_count = usage_count + 1 WHERE id = $1', [id]);
}

// ========== User Preferences ==========

async function getUserPreferences(userId) {
  const { rows } = await q('SELECT * FROM user_preferences WHERE user_id = $1', [userId]);
  return rows[0];
}

async function upsertUserPreferences(userId, prefs) {
  const { rows } = await q(`
    INSERT INTO user_preferences(user_id, default_personality_id, default_model_id, 
                                 ui_settings, context_strategy, auto_context_max_tokens)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (user_id) DO UPDATE SET
      default_personality_id = COALESCE($2, user_preferences.default_personality_id),
      default_model_id = COALESCE($3, user_preferences.default_model_id),
      ui_settings = COALESCE($4, user_preferences.ui_settings),
      context_strategy = COALESCE($5, user_preferences.context_strategy),
      auto_context_max_tokens = COALESCE($6, user_preferences.auto_context_max_tokens),
      updated_at = now()
    RETURNING *`,
    [userId, prefs.default_personality_id, prefs.default_model_id,
     prefs.ui_settings, prefs.context_strategy, prefs.auto_context_max_tokens]
  );
  return rows[0];
}

// ========== Context Management ==========

async function getContextMessages(branchId, maxTokens) {
  // Get all messages with metadata
  const { rows: messages } = await q(`
    SELECT cm.*, mm.is_pinned, mm.priority_level, mm.rating, mm.in_context, mm.summary
    FROM conversation_messages cm
    LEFT JOIN message_metadata mm ON mm.message_id = cm.id
    WHERE cm.branch_id = $1
    ORDER BY cm.id ASC`,
    [branchId]
  );

  // Simple token-based filtering (in real impl, use proper tokenizer)
  let totalTokens = 0;
  const included = [];
  const pinned = [];

  // First pass: collect pinned messages
  for (const msg of messages) {
    if (msg.is_pinned) {
      pinned.push(msg);
      totalTokens += msg.tokens || 0;
    }
  }

  // Second pass: add high-priority messages until we hit token limit
  for (const msg of messages.reverse()) { // Most recent first
    if (msg.is_pinned) continue;
    
    const msgTokens = msg.tokens || 0;
    if (totalTokens + msgTokens <= maxTokens) {
      included.push(msg);
      totalTokens += msgTokens;
    }
  }

  return [...pinned, ...included.reverse()];
}

module.exports = {
  q, pool,
  // Goals
  getConversationGoal, createConversationGoal, updateConversationGoal,
  // Branches
  createBranch, getBranches, getBranch, setActiveBranch, updateBranch, deleteBranch, getBranchMessages,
  // Message metadata
  getMessageMetadata, upsertMessageMetadata,
  // Personalities
  listPersonalities, getPersonality, createPersonality, updatePersonality, 
  deletePersonality, incrementPersonalityUsage,
  // Schemas
  listSchemas, getSchema, createSchema, updateSchema, deleteSchema, 
  incrementSchemaUsage, saveStructuredResponse,
  // Advisor
  saveAdvisorSuggestion, getAdvisorSuggestions,
  // Smart actions
  listSmartActions, getSmartAction, incrementActionUsage,
  // User preferences
  getUserPreferences, upsertUserPreferences,
  // Context
  getContextMessages
};
