const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'llm_chat_ui',
  max: 20
});

pool.on('connect', (client) => 
  client.query(`SET application_name = 'llm-chat-ui'`).catch(()=>{})
);

async function q(text, params) {
  const client = await pool.connect();
  try { 
    return await client.query(text, params); 
  } finally { 
    client.release(); 
  }
}

/**
 * Initialize all database tables
 * Organized by feature module for clarity
 */
async function initDb() {
  console.log('Initializing database schema...');

  // ========== CORE: Conversations & Messages ==========
  await q(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      parent_branch_id TEXT DEFAULT NULL, -- For branching: references another conversation
      branch_point_message_id BIGINT DEFAULT NULL, -- Message where branch occurred
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now(),
      title TEXT,
      system_prompt TEXT,
      model_id INTEGER,
      personality_id INTEGER,
      meta JSONB,
      archived BOOLEAN DEFAULT false,
      FOREIGN KEY (parent_branch_id) REFERENCES conversations(id) ON DELETE CASCADE
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
      in_context BOOLEAN DEFAULT true, -- Whether message is in active context
      priority INTEGER DEFAULT 50, -- 0-100, for context management
      pinned BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now(),
      meta JSONB,
      structured_data_id BIGINT -- Links to structured_responses if structured output used
    );
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_conv_messages_conv 
           ON conversation_messages(conversation_id, created_at DESC);`);
  
  await q(`CREATE INDEX IF NOT EXISTS idx_conv_messages_context
           ON conversation_messages(conversation_id, in_context) 
           WHERE in_context = true;`);

  // ========== BRANCHING: Tree relationships ==========
  await q(`
    CREATE TABLE IF NOT EXISTS conversation_branches (
      id SERIAL PRIMARY KEY,
      parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      child_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      branch_message_id BIGINT, -- Message where branch occurred
      branch_type TEXT DEFAULT 'manual', -- manual, advisor, comparison, experiment
      created_at TIMESTAMP DEFAULT now(),
      meta JSONB
    );
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_branches_parent 
           ON conversation_branches(parent_conversation_id);`);
  
  await q(`CREATE INDEX IF NOT EXISTS idx_branches_child
           ON conversation_branches(child_conversation_id);`);

  // ========== GOALS: Conversation goals & tracking ==========
  await q(`
    CREATE TABLE IF NOT EXISTS conversation_goals (
      id SERIAL PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      goal_text TEXT NOT NULL,
      goal_type TEXT, -- create_deliverable, learn, debug, brainstorm, research, refine
      success_criteria JSONB, -- Array of criteria objects
      constraints JSONB, -- Constraints/requirements
      progress INTEGER DEFAULT 0, -- 0-100
      completed BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_goals_conversation
           ON conversation_goals(conversation_id);`);

  // ========== ADVISOR: Suggestions & patterns ==========
  await q(`
    CREATE TABLE IF NOT EXISTS advisor_suggestions (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      goal_id INTEGER REFERENCES conversation_goals(id) ON DELETE CASCADE,
      message_id BIGINT,
      suggestion_type TEXT NOT NULL, -- next_prompt, path, blocker, quality, validation
      suggestions JSONB NOT NULL, -- Array of suggestion objects
      selected_index INTEGER, -- Which suggestion user picked
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS conversation_patterns (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      goal_type TEXT,
      description TEXT,
      prompt_sequence JSONB NOT NULL, -- Ordered array of prompts
      avg_exchanges INTEGER,
      avg_cost NUMERIC(12,6),
      success_rate NUMERIC(3,2), -- 0-1
      usage_count INTEGER DEFAULT 0,
      tags TEXT[],
      created_by TEXT,
      is_public BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // ========== PERSONALITIES: LLM personas ==========
  await q(`
    CREATE TABLE IF NOT EXISTS personality_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      system_prompt TEXT NOT NULL,
      model_preference TEXT, -- Preferred model key
      temperature NUMERIC(3,2) DEFAULT 0.7,
      max_tokens INTEGER DEFAULT 2000,
      response_style JSONB, -- Formatting preferences
      tags TEXT[],
      usage_count INTEGER DEFAULT 0,
      avg_rating NUMERIC(3,2), -- User ratings
      created_by TEXT,
      is_public BOOLEAN DEFAULT false,
      is_system BOOLEAN DEFAULT false, -- Built-in personalities
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  // Insert default personalities
  await q(`
    INSERT INTO personality_profiles 
    (name, description, system_prompt, temperature, is_system, is_public)
    VALUES 
    ('Professor', 
     'Thorough, educational, includes examples and explanations',
     'You are an expert educator. Always explain concepts thoroughly, provide examples, and check for understanding. Use analogies when helpful. Break complex topics into digestible parts.',
     0.7, true, true),
    ('Speed Demon',
     'Concise, direct, minimal explanation',
     'Be extremely concise. Give direct answers without explanation unless asked. Use bullet points. Prioritize speed over detail.',
     0.3, true, true),
    ('Code Specialist',
     'Code-focused, best practices, design patterns',
     'You are a senior software engineer. Focus on production-ready code, best practices, testing, and maintainability. Include comments and explain architectural decisions.',
     0.2, true, true),
    ('Creative Brainstormer',
     'Innovative, exploratory, lateral thinking',
     'You are a creative innovator. Explore unconventional ideas, make unexpected connections, and encourage lateral thinking. Be imaginative and thought-provoking.',
     1.0, true, true),
    ('Debugger',
     'Analytical, systematic, detail-oriented',
     'You are a systematic debugger. Analyze problems methodically, identify root causes, and provide step-by-step solutions. Be thorough and precise.',
     0.1, true, true),
    ('Code Reviewer',
     'Critical, security-focused, improvement suggestions',
     'You are a senior code reviewer. Focus on code quality, security, performance, and maintainability. Provide constructive criticism and actionable improvements.',
     0.3, true, true)
    ON CONFLICT (name) DO NOTHING;
  `);

  // ========== STRUCTURED OUTPUT: Schemas & validation ==========
  await q(`
    CREATE TABLE IF NOT EXISTS output_schemas (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      schema_definition JSONB NOT NULL, -- JSON Schema format
      category TEXT, -- api, data, code, business, etc.
      tags TEXT[],
      validation_mode TEXT DEFAULT 'strict', -- strict, flexible, none
      usage_count INTEGER DEFAULT 0,
      avg_validation_success NUMERIC(3,2), -- 0-1
      created_by TEXT,
      is_public BOOLEAN DEFAULT false,
      is_system BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  // Insert default schemas
  await q(`
    INSERT INTO output_schemas 
    (name, description, schema_definition, category, is_system, is_public)
    VALUES 
    ('API Response',
     'Standard REST API response format',
     '{"type":"object","properties":{"status":{"type":"string","enum":["success","error"]},"data":{"type":"object"},"message":{"type":"string"},"timestamp":{"type":"string","format":"date-time"}},"required":["status"]}',
     'api', true, true),
    ('Task List',
     'Structured task breakdown',
     '{"type":"object","properties":{"tasks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},"priority":{"type":"string","enum":["high","medium","low"]},"estimated_effort":{"type":"string"},"dependencies":{"type":"array","items":{"type":"string"}}},"required":["title","priority"]}},"metadata":{"type":"object"}},"required":["tasks"]}',
     'business', true, true),
    ('Bug Report',
     'Structured bug information',
     '{"type":"object","properties":{"bugs":{"type":"array","items":{"type":"object","properties":{"severity":{"type":"string","enum":["critical","high","medium","low"]},"location":{"type":"string"},"description":{"type":"string"},"reproduction_steps":{"type":"array","items":{"type":"string"}},"expected":{"type":"string"},"actual":{"type":"string"},"suggested_fix":{"type":"string"}},"required":["severity","description"]}}},"required":["bugs"]}',
     'code', true, true),
    ('Data Extraction',
     'Extract structured data from text',
     '{"type":"object","properties":{"extracted_data":{"type":"array","items":{"type":"object"}},"confidence":{"type":"number","minimum":0,"maximum":1},"metadata":{"type":"object"}},"required":["extracted_data"]}',
     'data', true, true)
    ON CONFLICT DO NOTHING;
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS structured_responses (
      id BIGSERIAL PRIMARY KEY,
      message_id BIGINT REFERENCES conversation_messages(id) ON DELETE CASCADE,
      schema_id INTEGER REFERENCES output_schemas(id) ON DELETE SET NULL,
      data JSONB NOT NULL,
      validation_status TEXT, -- valid, invalid, partial, not_validated
      validation_errors JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS schema_usage (
      id BIGSERIAL PRIMARY KEY,
      schema_id INTEGER REFERENCES output_schemas(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      message_id BIGINT,
      validation_passed BOOLEAN,
      validation_errors JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // ========== TEMPLATES: Prompt templates ==========
  await q(`
    CREATE TABLE IF NOT EXISTS prompt_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      template TEXT NOT NULL,
      variables JSONB, -- Variable definitions
      description TEXT,
      category TEXT,
      tags TEXT[],
      personality_id INTEGER REFERENCES personality_profiles(id) ON DELETE SET NULL,
      schema_id INTEGER REFERENCES output_schemas(id) ON DELETE SET NULL,
      usage_count INTEGER DEFAULT 0,
      avg_tokens INTEGER,
      avg_cost NUMERIC(12,6),
      avg_rating NUMERIC(3,2),
      created_by TEXT,
      is_public BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now(),
      updated_at TIMESTAMP DEFAULT now(),
      archived BOOLEAN DEFAULT false,
      UNIQUE(name, version)
    );
  `);

  await q(`CREATE INDEX IF NOT EXISTS idx_templates_name 
           ON prompt_templates(name) WHERE NOT archived;`);

  // ========== SMART ACTIONS: Action configurations ==========
  await q(`
    CREATE TABLE IF NOT EXISTS smart_actions (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL,
      description TEXT,
      category TEXT, -- transformation, workflow, analysis, code
      icon TEXT,
      action_type TEXT NOT NULL, -- prompt, api_call, transformation, workflow
      config JSONB NOT NULL, -- Action-specific configuration
      personality_id INTEGER REFERENCES personality_profiles(id) ON DELETE SET NULL,
      schema_id INTEGER REFERENCES output_schemas(id) ON DELETE SET NULL,
      usage_count INTEGER DEFAULT 0,
      is_system BOOLEAN DEFAULT false,
      is_enabled BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // Insert default smart actions
  await q(`
    INSERT INTO smart_actions 
    (name, label, description, category, action_type, config, is_system)
    VALUES
    ('simplify', 'Simplify', 'Make response more concise', 'transformation', 'prompt',
     '{"prompt":"Simplify the following text, making it more concise while preserving key information:"}', true),
    ('expand', 'Expand', 'Add more detail and explanation', 'transformation', 'prompt',
     '{"prompt":"Expand on the following text, adding more detail, examples, and explanation:"}', true),
    ('extract_code', 'Extract Code', 'Extract all code blocks', 'code', 'transformation',
     '{"extract_type":"code_blocks"}', true),
    ('optimize_context', 'Optimize Context', 'Run context compression', 'workflow', 'api_call',
     '{"endpoint":"/api/context/optimize"}', true),
    ('create_branch', 'Branch Here', 'Create new conversation branch', 'workflow', 'api_call',
     '{"endpoint":"/api/conversations/branch"}', true),
    ('fact_check', 'Fact Check', 'Verify claims with search', 'analysis', 'prompt',
     '{"prompt":"Fact-check the following claims. For each claim, verify accuracy and provide sources:"}', true)
    ON CONFLICT (name) DO NOTHING;
  `);

  // ========== CONTEXT MANAGEMENT: Snapshots & strategies ==========
  await q(`
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id BIGSERIAL PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      snapshot_name TEXT,
      message_ids BIGINT[], -- Array of message IDs in context
      total_tokens INTEGER,
      strategy_used TEXT, -- manual, auto_summarize, semantic, sliding_window
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS context_strategies (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      strategy_type TEXT NOT NULL, -- manual, auto_summarize, semantic_compression, sliding_window, hybrid
      config JSONB NOT NULL, -- Strategy-specific settings
      is_system BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // Insert default context strategies
  await q(`
    INSERT INTO context_strategies (name, description, strategy_type, config, is_system)
    VALUES
    ('Keep Recent', 'Keep most recent N messages', 'sliding_window',
     '{"keep_count":20,"always_keep_system":true}', true),
    ('Auto Summarize', 'Summarize old messages', 'auto_summarize',
     '{"summarize_threshold":10,"max_summary_tokens":500}', true),
    ('Manual Priority', 'User-defined message priorities', 'manual',
     '{"respect_pins":true,"priority_threshold":50}', true),
    ('Semantic Compression', 'Keep semantically important messages', 'semantic_compression',
     '{"similarity_threshold":0.7,"keep_diverse":true}', true)
    ON CONFLICT (name) DO NOTHING;
  `);

  // ========== WORKFLOWS: Multi-step pipelines ==========
  await q(`
    CREATE TABLE IF NOT EXISTS output_workflows (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      steps JSONB NOT NULL, -- Array of workflow step definitions
      tags TEXT[],
      usage_count INTEGER DEFAULT 0,
      avg_duration_seconds INTEGER,
      success_rate NUMERIC(3,2),
      created_by TEXT,
      is_public BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  // ========== ANALYTICS: Usage tracking ==========
  await q(`
    CREATE TABLE IF NOT EXISTS message_analytics (
      id BIGSERIAL PRIMARY KEY,
      message_id BIGINT REFERENCES conversation_messages(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      personality_id INTEGER REFERENCES personality_profiles(id) ON DELETE SET NULL,
      schema_id INTEGER REFERENCES output_schemas(id) ON DELETE SET NULL,
      user_rating INTEGER, -- 1-5
      regeneration_count INTEGER DEFAULT 0,
      edit_count INTEGER DEFAULT 0,
      branch_count INTEGER DEFAULT 0,
      time_to_response_ms INTEGER,
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  console.log('✅ Database schema initialized successfully');
}

/**
 * Get database pool for direct queries
 */
function getPool() {
  return pool;
}

/**
 * Graceful shutdown
 */
async function closeDb() {
  await pool.end();
  console.log('Database pool closed');
}

module.exports = {
  initDb,
  q,
  getPool,
  closeDb
};
