-- ============================================================
-- LLM Chat UI - Extended Database Schema
-- Extends the existing llm-gateway schema
-- ============================================================

-- Conversation Goals
CREATE TABLE IF NOT EXISTS conversation_goals (
  id SERIAL PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  goal_text TEXT NOT NULL,
  goal_type TEXT, -- 'create_deliverable', 'learn', 'debug', 'research', etc.
  success_criteria JSONB, -- Array of criteria with checked status
  constraints JSONB, -- Technologies, requirements, limitations
  progress INTEGER DEFAULT 0 CHECK (progress >= 0 AND progress <= 100),
  completed BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_conv_goals_conv ON conversation_goals(conversation_id);

-- Conversation Branches (tree structure)
CREATE TABLE IF NOT EXISTS conversation_branches (
  id TEXT PRIMARY KEY, -- branch-{uuid}
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  parent_branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE,
  branch_point_message_id BIGINT, -- Message where branch started
  name TEXT, -- User-given name for branch
  description TEXT,
  is_active BOOLEAN DEFAULT false, -- Currently active branch
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_branches_conv ON conversation_branches(conversation_id);
CREATE INDEX idx_branches_parent ON conversation_branches(parent_branch_id);

-- Add branch_id to conversation_messages
ALTER TABLE conversation_messages 
ADD COLUMN IF NOT EXISTS branch_id TEXT REFERENCES conversation_branches(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_messages_branch ON conversation_messages(branch_id, created_at);

-- Message Metadata (ratings, pins, etc.)
CREATE TABLE IF NOT EXISTS message_metadata (
  message_id BIGINT PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
  is_pinned BOOLEAN DEFAULT false,
  priority_level INTEGER DEFAULT 2, -- 0=droppable, 1=summarizable, 2=normal, 3=important, 4=critical
  rating INTEGER CHECK (rating >= 1 AND rating <= 5), -- User rating
  tokens_actual INTEGER, -- Actual tokens used (may differ from estimate)
  in_context BOOLEAN DEFAULT true, -- Currently included in context
  summary TEXT, -- AI-generated summary for compression
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Personality Profiles
CREATE TABLE IF NOT EXISTS personality_profiles (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  system_prompt TEXT NOT NULL,
  model_preference TEXT, -- Preferred model key
  temperature NUMERIC(3,2) DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 2000,
  response_style JSONB, -- { bullets: true, examples: true, verbose: false, etc. }
  tags TEXT[],
  is_public BOOLEAN DEFAULT false,
  is_builtin BOOLEAN DEFAULT false,
  usage_count INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Output Schemas (for structured output)
CREATE TABLE IF NOT EXISTS output_schemas (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  schema_definition JSONB NOT NULL, -- JSON Schema format
  category TEXT, -- 'api', 'data_extraction', 'analysis', etc.
  tags TEXT[],
  is_public BOOLEAN DEFAULT false,
  validation_mode TEXT DEFAULT 'strict', -- strict, flexible, none
  usage_count INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_schemas_category ON output_schemas(category) WHERE NOT is_public;

-- Schema Usage Tracking
CREATE TABLE IF NOT EXISTS schema_usage (
  id BIGSERIAL PRIMARY KEY,
  schema_id INTEGER REFERENCES output_schemas(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  message_id BIGINT REFERENCES conversation_messages(id) ON DELETE CASCADE,
  validation_passed BOOLEAN,
  validation_errors JSONB,
  created_at TIMESTAMP DEFAULT now()
);

-- Structured Responses (extracted structured data)
CREATE TABLE IF NOT EXISTS structured_responses (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT REFERENCES conversation_messages(id) ON DELETE CASCADE,
  schema_id INTEGER REFERENCES output_schemas(id) ON DELETE SET NULL,
  data JSONB NOT NULL,
  validation_status TEXT, -- 'valid', 'invalid', 'partial'
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_structured_msg ON structured_responses(message_id);

-- Prompt Advisor Suggestions
CREATE TABLE IF NOT EXISTS advisor_suggestions (
  id BIGSERIAL PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
  goal_id INTEGER REFERENCES conversation_goals(id) ON DELETE CASCADE,
  suggestion_type TEXT, -- 'next_prompt', 'path', 'blocker', 'quality', 'personality_switch'
  suggestions JSONB NOT NULL, -- Array of suggestion objects
  selected_index INTEGER, -- Which suggestion user picked
  message_id BIGINT, -- Message that resulted from selection
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_advisor_conv ON advisor_suggestions(conversation_id);

-- Conversation Patterns (learned successful paths)
CREATE TABLE IF NOT EXISTS conversation_patterns (
  id SERIAL PRIMARY KEY,
  goal_type TEXT,
  pattern_name TEXT,
  description TEXT,
  prompt_sequence JSONB NOT NULL, -- Ordered array of prompt templates
  avg_exchanges INTEGER,
  avg_tokens INTEGER,
  avg_cost NUMERIC(10,4),
  success_rate NUMERIC(3,2), -- 0-1
  prerequisites JSONB, -- What conditions make this pattern applicable
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Smart Action Buttons (user-customizable)
CREATE TABLE IF NOT EXISTS smart_actions (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT, -- Emoji or icon identifier
  category TEXT, -- 'content', 'workflow', 'analysis', 'code'
  prompt_template TEXT NOT NULL, -- Template with {{placeholders}}
  personality_id INTEGER REFERENCES personality_profiles(id) ON DELETE SET NULL,
  output_schema_id INTEGER REFERENCES output_schemas(id) ON DELETE SET NULL,
  is_builtin BOOLEAN DEFAULT false,
  is_public BOOLEAN DEFAULT false,
  order_index INTEGER DEFAULT 0,
  usage_count INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- User Preferences
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT PRIMARY KEY,
  default_personality_id INTEGER REFERENCES personality_profiles(id) ON DELETE SET NULL,
  default_model_id INTEGER REFERENCES models(id) ON DELETE SET NULL,
  ui_settings JSONB, -- Theme, layout preferences, etc.
  context_strategy TEXT DEFAULT 'hybrid', -- 'manual', 'auto', 'hybrid', etc.
  auto_context_max_tokens INTEGER DEFAULT 8000,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Add conversation-level settings
ALTER TABLE conversations 
ADD COLUMN IF NOT EXISTS personality_id INTEGER REFERENCES personality_profiles(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS branch_count INTEGER DEFAULT 1,
ADD COLUMN IF NOT EXISTS active_branch_id TEXT REFERENCES conversation_branches(id) ON DELETE SET NULL;

-- Insert default personalities
INSERT INTO personality_profiles (name, description, system_prompt, temperature, is_builtin) VALUES
('Default Assistant', 'Balanced, helpful assistant', 
 'You are a helpful, balanced AI assistant. Provide clear, accurate information and be friendly.', 
 0.7, true),
('Professor', 'Thorough educator with examples',
 'You are an expert educator. Always explain concepts thoroughly, provide examples, and check for understanding. Use analogies when helpful. Break complex topics into digestible parts.',
 0.7, true),
('Speed Demon', 'Concise and direct',
 'Be extremely concise. Give direct answers without explanation unless asked. Use bullet points. Prioritize speed over detail.',
 0.3, true),
('Code Specialist', 'Production-ready code expert',
 'You are a senior software engineer. Focus on production-ready code, best practices, testing, and maintainability. Include comments and explain architectural decisions. Always consider security and performance.',
 0.2, true),
('Debugger', 'Systematic problem solver',
 'You are an expert debugger. Be analytical and systematic. Break down problems methodically. Ask clarifying questions. Identify root causes. Provide step-by-step solutions.',
 0.1, true),
('Creative Brainstormer', 'Innovative and exploratory',
 'You are a creative innovator. Think outside the box. Suggest multiple approaches. Use lateral thinking. Encourage experimentation. Prioritize novel solutions.',
 1.0, true),
('Code Reviewer', 'Critical and security-focused',
 'You are a strict code reviewer. Focus on security, performance, and best practices. Be critical but constructive. Point out potential issues, anti-patterns, and suggest improvements.',
 0.3, true)
ON CONFLICT (name) DO NOTHING;

-- Insert common output schemas
INSERT INTO output_schemas (name, description, schema_definition, category, is_public) VALUES
('API Response', 'Standard REST API response format',
 '{"type":"object","properties":{"status":{"type":"string","enum":["success","error"]},"data":{"type":"object"},"message":{"type":"string"},"timestamp":{"type":"string","format":"date-time"}},"required":["status","data"]}',
 'api', true),
('Task List', 'Structured task breakdown',
 '{"type":"object","properties":{"tasks":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"description":{"type":"string"},"priority":{"type":"string","enum":["high","medium","low"]},"estimated_effort":{"type":"string"},"dependencies":{"type":"array","items":{"type":"string"}},"completed":{"type":"boolean"}},"required":["title","priority"]}}}}',
 'workflow', true),
('Bug Report', 'Structured bug information',
 '{"type":"object","properties":{"bugs":{"type":"array","items":{"type":"object","properties":{"severity":{"type":"string","enum":["critical","high","medium","low"]},"location":{"type":"string"},"description":{"type":"string"},"steps_to_reproduce":{"type":"array","items":{"type":"string"}},"expected_behavior":{"type":"string"},"actual_behavior":{"type":"string"},"suggested_fix":{"type":"string"}},"required":["severity","description"]}}},"required":["bugs"]}',
 'debugging', true),
('Data Extraction', 'Extract structured data from text',
 '{"type":"object","properties":{"items":{"type":"array","items":{"type":"object"}},"metadata":{"type":"object","properties":{"source":{"type":"string"},"extracted_at":{"type":"string","format":"date-time"},"confidence":{"type":"number","minimum":0,"maximum":1}}}}}',
 'data', true),
('Analysis Report', 'Structured analysis with insights',
 '{"type":"object","properties":{"summary":{"type":"string"},"key_findings":{"type":"array","items":{"type":"string"}},"recommendations":{"type":"array","items":{"type":"object","properties":{"recommendation":{"type":"string"},"priority":{"type":"string"},"rationale":{"type":"string"}}}},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["summary","key_findings"]}',
 'analysis', true)
ON CONFLICT DO NOTHING;

-- Insert default smart actions
INSERT INTO smart_actions (name, description, icon, category, prompt_template, is_builtin) VALUES
('Simplify', 'Make response more concise', '📝', 'content', 'Simplify this response to be more concise while keeping the key information: {{selected_text}}', true),
('Expand', 'Add more detail and examples', '📖', 'content', 'Expand on this with more detail and examples: {{selected_text}}', true),
('Explain Like I''m 5', 'Simplify for beginners', '🎈', 'content', 'Explain this concept in very simple terms that a beginner can understand: {{selected_text}}', true),
('Extract Key Points', 'Create bullet summary', '🎯', 'content', 'Extract the key points from this text as a bullet list: {{selected_text}}', true),
('Find Contradictions', 'Check for inconsistencies', '🔍', 'analysis', 'Analyze this conversation for any contradictions or inconsistencies: {{conversation_context}}', true),
('Generate Tests', 'Create test cases', '🧪', 'code', 'Generate comprehensive test cases for this code: {{selected_text}}', true),
('Review Security', 'Check for security issues', '🔒', 'code', 'Review this code for security vulnerabilities: {{selected_text}}', true),
('Optimize Code', 'Improve performance', '⚡', 'code', 'Optimize this code for better performance: {{selected_text}}', true),
('Continue in Branch', 'Fork conversation', '🌿', 'workflow', 'Let''s explore this alternative approach: {{selected_text}}', true)
ON CONFLICT DO NOTHING;

-- Create a default main branch for existing conversations
INSERT INTO conversation_branches (id, conversation_id, name, is_active)
SELECT 'branch-main-' || id, id, 'main', true 
FROM conversations 
WHERE NOT EXISTS (
  SELECT 1 FROM conversation_branches WHERE conversation_branches.conversation_id = conversations.id
);

-- Update existing messages to belong to main branch
UPDATE conversation_messages 
SET branch_id = 'branch-main-' || conversation_id 
WHERE branch_id IS NULL;
