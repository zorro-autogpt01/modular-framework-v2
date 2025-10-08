const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'llm_gateway',
  max: 10
});
pool.on('connect', (client) => client.query(`SET application_name = 'llm-gateway'`).catch(()=>{}));

async function q(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

async function initDb() {
  // Existing tables
  await q(`
    CREATE TABLE IF NOT EXISTS providers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('openai','openai-compatible','ollama')),
      base_url TEXT NOT NULL,
      api_key TEXT,
      headers JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS models (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE,
      key TEXT UNIQUE,
      model_name TEXT NOT NULL,
      display_name TEXT,
      mode TEXT NOT NULL DEFAULT 'auto',
      supports_responses BOOLEAN DEFAULT false,
      supports_reasoning BOOLEAN DEFAULT false,
      input_cost_per_million NUMERIC(12,6) DEFAULT 0,
      output_cost_per_million NUMERIC(12,6) DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMP DEFAULT now(),
      provider_id INTEGER REFERENCES providers(id) ON DELETE SET NULL,
      model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
      conversation_id TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      prompt_chars INTEGER,
      completion_chars INTEGER,
      cost NUMERIC(12,6),
      meta JSONB
    );
  `);

  // NEW: Conversations table
  await q(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now(),
      title TEXT,
      system_prompt TEXT,
      model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
      meta JSONB,
      archived BOOLEAN DEFAULT false
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
      content TEXT,
      tokens INTEGER,
      cost NUMERIC(12,6),
      created_at TIMESTAMP DEFAULT now(),
      meta JSONB
    );
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_conv_messages_conv 
           ON conversation_messages(conversation_id, created_at DESC);`);

  // NEW: Prompt Templates table
  await q(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      template TEXT NOT NULL,
      variables JSONB,
      description TEXT,
      tags TEXT[],
      usage_count INTEGER DEFAULT 0,
      avg_tokens INTEGER,
      avg_cost NUMERIC(12,6),
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now(),
      archived BOOLEAN DEFAULT false,
      UNIQUE(name, version)
    );
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_templates_name 
           ON prompt_templates(name) WHERE NOT archived;`);
}

// ========== Existing Provider/Model/Usage functions ==========
async function listProviders() {
  const { rows } = await q('SELECT * FROM providers ORDER BY id ASC');
  return rows;
}

async function getProvider(id) {
  const { rows } = await q('SELECT * FROM providers WHERE id=$1', [id]);
  return rows[0];
}

async function createProvider(p) {
  const { rows } = await q(
    `INSERT INTO providers(name, kind, base_url, api_key, headers) 
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [p.name, p.kind, p.base_url, p.api_key || null, p.headers || null]
  );
  return rows[0];
}

async function updateProvider(id, p) {
  const { rows } = await q(
    `UPDATE providers SET name=$1, kind=$2, base_url=$3, api_key=$4, headers=$5 
     WHERE id=$6 RETURNING *`,
    [p.name, p.kind, p.base_url, p.api_key || null, p.headers || null, id]
  );
  return rows[0];
}

async function deleteProvider(id) {
  await q('DELETE FROM providers WHERE id=$1', [id]);
}

async function listModels() {
  const { rows } = await q(`
    SELECT m.*, p.name as provider_name, p.kind as provider_kind, p.base_url as provider_base_url
    FROM models m
    LEFT JOIN providers p ON p.id=m.provider_id
    ORDER BY m.id ASC
  `);
  return rows;
}

async function getModel(id) {
  const { rows } = await q(`
    SELECT m.*, p.name as provider_name, p.kind as provider_kind, 
           p.base_url as provider_base_url, p.api_key as provider_api_key, 
           p.headers as provider_headers, p.id as provider_id
    FROM models m
    LEFT JOIN providers p ON p.id=m.provider_id
    WHERE m.id=$1
  `, [id]);
  return rows[0];
}

async function getModelByKey(key) {
  const { rows } = await q(`
    SELECT m.*, p.name as provider_name, p.kind as provider_kind, 
           p.base_url as provider_base_url, p.api_key as provider_api_key, 
           p.headers as provider_headers, p.id as provider_id
    FROM models m LEFT JOIN providers p ON p.id=m.provider_id
    WHERE m.key=$1
  `, [key]);
  return rows[0];
}

async function getModelByName(model_name) {
  const { rows } = await q(`
    SELECT m.*, p.name as provider_name, p.kind as provider_kind, 
           p.base_url as provider_base_url, p.api_key as provider_api_key, 
           p.headers as provider_headers, p.id as provider_id
    FROM models m LEFT JOIN providers p ON p.id=m.provider_id
    WHERE m.model_name=$1
    LIMIT 1
  `, [model_name]);
  return rows[0];
}

async function createModel(m) {
  const { rows } = await q(`
    INSERT INTO models(provider_id, key, model_name, display_name, mode, 
                       supports_responses, supports_reasoning, 
                       input_cost_per_million, output_cost_per_million, currency)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *`,
    [
      m.provider_id, m.key || null, m.model_name, m.display_name || null, 
      m.mode || 'auto', !!m.supports_responses, !!m.supports_reasoning,
      m.input_cost_per_million || 0, m.output_cost_per_million || 0, 
      m.currency || 'USD'
    ]
  );
  return rows[0];
}

async function updateModel(id, m) {
  const { rows } = await q(`
    UPDATE models
    SET provider_id=$1, key=$2, model_name=$3, display_name=$4, mode=$5, 
        supports_responses=$6, supports_reasoning=$7, 
        input_cost_per_million=$8, output_cost_per_million=$9, currency=$10
    WHERE id=$11 RETURNING *`,
    [
      m.provider_id, m.key || null, m.model_name, m.display_name || null, 
      m.mode || 'auto', !!m.supports_responses, !!m.supports_reasoning,
      m.input_cost_per_million || 0, m.output_cost_per_million || 0, 
      m.currency || 'USD', id
    ]
  );
  return rows[0];
}

async function deleteModel(id) {
  await q('DELETE FROM models WHERE id=$1', [id]);
}

async function logUsage(u) {
  const { rows } = await q(`
    INSERT INTO usage_log(provider_id, model_id, conversation_id, 
                          input_tokens, output_tokens, prompt_chars, 
                          completion_chars, cost, meta)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `, [
    u.provider_id || null, u.model_id || null, u.conversation_id || null,
    u.input_tokens || null, u.output_tokens || null,
    u.prompt_chars || null, u.completion_chars || null,
    u.cost || null, u.meta || null
  ]);
  return rows[0];
}

async function recentUsage(limit = 200) {
  const lim = Math.max(1, Math.min(Number(limit || 200), 2000));
  const { rows } = await q(
    'SELECT * FROM usage_log ORDER BY id DESC LIMIT $1', 
    [lim]
  );
  return rows;
}

async function getUsageById(id) {
  const { rows } = await q('SELECT * FROM usage_log WHERE id=$1', [id]);
  return rows[0];
}

// ========== NEW: Conversation Management ==========

async function listConversations({ limit = 50, archived = false, search = null } = {}) {
  let query = `
    SELECT c.*, 
           COUNT(cm.id) as message_count,
           MAX(cm.created_at) as last_message_at,
           m.display_name as model_name
    FROM conversations c
    LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
    LEFT JOIN models m ON m.id = c.model_id
    WHERE c.archived = $1
  `;
  const params = [archived];
  
  if (search) {
    query += ` AND (c.title ILIKE $${params.length + 1} OR c.id ILIKE $${params.length + 1})`;
    params.push(`%${search}%`);
  }
  
  query += `
    GROUP BY c.id, m.display_name
    ORDER BY COALESCE(MAX(cm.created_at), c.created_at) DESC
    LIMIT $${params.length + 1}
  `;
  params.push(Math.min(Number(limit), 200));
  
  const { rows } = await q(query, params);
  return rows;
}

async function getConversation(id) {
  const { rows } = await q(`
    SELECT c.*, m.display_name as model_name
    FROM conversations c
    LEFT JOIN models m ON m.id = c.model_id
    WHERE c.id = $1
  `, [id]);
  return rows[0];
}

async function createConversation(conv) {
  const { rows } = await q(`
    INSERT INTO conversations(id, title, system_prompt, model_id, meta)
    VALUES ($1, $2, $3, $4, $5) RETURNING *
  `, [
    conv.id, 
    conv.title || null, 
    conv.system_prompt || null,
    conv.model_id || null,
    conv.meta || null
  ]);
  return rows[0];
}

async function updateConversation(id, updates) {
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
  return rows[0];
}

async function deleteConversation(id) {
  await q('DELETE FROM conversations WHERE id=$1', [id]);
}

async function getConversationMessages(convId, { limit = 100, before = null } = {}) {
  let query = `
    SELECT * FROM conversation_messages 
    WHERE conversation_id = $1
  `;
  const params = [convId];

  if (before) {
    query += ` AND id < $2`;
    params.push(before);
  }

  query += ` ORDER BY id DESC LIMIT $${params.length + 1}`;
  params.push(Math.min(Number(limit), 500));

  const { rows } = await q(query, params);
  return rows.reverse(); // return in chronological order
}

async function addConversationMessage(msg) {
  const { rows } = await q(`
    INSERT INTO conversation_messages(conversation_id, role, content, tokens, cost, meta)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [
    msg.conversation_id,
    msg.role,
    msg.content || null,
    msg.tokens || null,
    msg.cost || null,
    msg.meta || null
  ]);

  // Update conversation updated_at
  await q('UPDATE conversations SET updated_at = now() WHERE id = $1', [msg.conversation_id]);
  
  return rows[0];
}

async function truncateConversationMessages(convId, maxTokens) {
  // Get messages oldest first
  const { rows: msgs } = await q(`
    SELECT id, tokens FROM conversation_messages 
    WHERE conversation_id = $1 AND role != 'system'
    ORDER BY id ASC
  `, [convId]);

  let total = 0;
  const toDelete = [];

  for (const msg of msgs) {
    total += msg.tokens || 0;
    if (total > maxTokens) {
      toDelete.push(msg.id);
    }
  }

  if (toDelete.length > 0) {
    await q(`DELETE FROM conversation_messages WHERE id = ANY($1)`, [toDelete]);
  }

  return toDelete.length;
}

// ========== NEW: Prompt Templates ==========

async function listTemplates({ archived = false, tags = null } = {}) {
  let query = `
    SELECT * FROM prompt_templates 
    WHERE archived = $1
  `;
  const params = [archived];

  if (tags && tags.length > 0) {
    query += ` AND tags && $2`;
    params.push(tags);
  }

  query += ` ORDER BY name ASC, version DESC`;

  const { rows } = await q(query, params);
  return rows;
}

async function getTemplate(id) {
  const { rows } = await q('SELECT * FROM prompt_templates WHERE id=$1', [id]);
  return rows[0];
}

async function getTemplateByName(name, version = null) {
  let query = 'SELECT * FROM prompt_templates WHERE name = $1';
  const params = [name];

  if (version !== null) {
    query += ' AND version = $2';
    params.push(version);
  } else {
    query += ' ORDER BY version DESC LIMIT 1';
  }

  const { rows } = await q(query, params);
  return rows[0];
}

async function createTemplate(tmpl) {
  // Get next version number for this name
  const { rows: existing } = await q(
    'SELECT MAX(version) as max_v FROM prompt_templates WHERE name = $1',
    [tmpl.name]
  );
  const nextVersion = (existing[0]?.max_v || 0) + 1;

  const { rows } = await q(`
    INSERT INTO prompt_templates(name, version, template, variables, description, tags)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
  `, [
    tmpl.name,
    nextVersion,
    tmpl.template,
    tmpl.variables || null,
    tmpl.description || null,
    tmpl.tags || null
  ]);
  return rows[0];
}

async function updateTemplate(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.template !== undefined) {
    fields.push(`template = $${idx++}`);
    values.push(updates.template);
  }
  if (updates.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(updates.description);
  }
  if (updates.variables !== undefined) {
    fields.push(`variables = $${idx++}`);
    values.push(updates.variables);
  }
  if (updates.tags !== undefined) {
    fields.push(`tags = $${idx++}`);
    values.push(updates.tags);
  }
  if (updates.archived !== undefined) {
    fields.push(`archived = $${idx++}`);
    values.push(updates.archived);
  }

  fields.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await q(`
    UPDATE prompt_templates 
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING *
  `, values);
  return rows[0];
}

async function deleteTemplate(id) {
  await q('DELETE FROM prompt_templates WHERE id=$1', [id]);
}

async function incrementTemplateUsage(id, tokens, cost) {
  await q(`
    UPDATE prompt_templates 
    SET usage_count = usage_count + 1,
        avg_tokens = CASE 
          WHEN usage_count = 0 THEN $2
          ELSE ((avg_tokens * usage_count) + $2) / (usage_count + 1)
        END,
        avg_cost = CASE
          WHEN usage_count = 0 THEN $3
          ELSE ((avg_cost * usage_count) + $3) / (usage_count + 1)
        END
    WHERE id = $1
  `, [id, tokens || 0, cost || 0]);
}

module.exports = {
  initDb, q,
  listProviders, getProvider, createProvider, updateProvider, deleteProvider,
  listModels, getModel, getModelByKey, getModelByName, createModel, updateModel, deleteModel,
  logUsage, recentUsage, getUsageById,
  // Conversations
  listConversations, getConversation, createConversation, updateConversation, deleteConversation,
  getConversationMessages, addConversationMessage, truncateConversationMessages,
  // Templates
  listTemplates, getTemplate, getTemplateByName, createTemplate, updateTemplate, 
  deleteTemplate, incrementTemplateUsage
};