-- code-slicer-service/scripts/schema.sql
-- Database schema for Code Slicer Service

-- Store code slice analyses
CREATE TABLE IF NOT EXISTS code_slices (
  id SERIAL PRIMARY KEY,
  slice_id VARCHAR(36) UNIQUE NOT NULL,
  repo VARCHAR(255) NOT NULL,
  branch VARCHAR(100) DEFAULT 'main',
  targets TEXT[] NOT NULL,
  context_lines INTEGER DEFAULT 10,
  hints TEXT[],
  language VARCHAR(50) DEFAULT 'auto',
  api_type VARCHAR(20) DEFAULT 'http',
  
  -- Results
  markdown_output TEXT,
  jsonl_output TEXT,
  graph_data TEXT,
  metadata JSONB,
  
  -- Stats
  files_analyzed INTEGER,
  snippets_count INTEGER,
  functions_count INTEGER,
  
  -- Timing
  duration_ms INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '30 days'
);

CREATE INDEX IF NOT EXISTS idx_slices_repo ON code_slices(repo);
CREATE INDEX IF NOT EXISTS idx_slices_slice_id ON code_slices(slice_id);
CREATE INDEX IF NOT EXISTS idx_slices_created ON code_slices(created_at);
CREATE INDEX IF NOT EXISTS idx_slices_expires ON code_slices(expires_at);

-- Track slice requests and usage
CREATE TABLE IF NOT EXISTS slice_requests (
  id SERIAL PRIMARY KEY,
  slice_id VARCHAR(36) REFERENCES code_slices(slice_id) ON DELETE CASCADE,
  requested_by VARCHAR(255),
  source VARCHAR(50) NOT NULL, -- 'workflow', 'ui', 'api', 'ide'
  source_id VARCHAR(255), -- workflow_id, user_id, etc.
  duration_ms INTEGER,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_requests_slice ON slice_requests(slice_id);
CREATE INDEX IF NOT EXISTS idx_requests_source ON slice_requests(source);
CREATE INDEX IF NOT EXISTS idx_requests_created ON slice_requests(created_at);

-- Cache layer for faster lookups
CREATE TABLE IF NOT EXISTS slice_cache (
  cache_key VARCHAR(64) PRIMARY KEY,
  repo VARCHAR(255) NOT NULL,
  targets_hash VARCHAR(64) NOT NULL,
  context_lines INTEGER,
  result JSONB NOT NULL,
  
  created_at TIMESTAMP DEFAULT NOW(),
  accessed_at TIMESTAMP DEFAULT NOW(),
  access_count INTEGER DEFAULT 1,
  
  UNIQUE(repo, targets_hash, context_lines)
);

CREATE INDEX IF NOT EXISTS idx_cache_repo ON slice_cache(repo);
CREATE INDEX IF NOT EXISTS idx_cache_accessed ON slice_cache(accessed_at);

-- Link slices to GitHub issues/PRs
CREATE TABLE IF NOT EXISTS slice_github_links (
  id SERIAL PRIMARY KEY,
  slice_id VARCHAR(36) REFERENCES code_slices(slice_id) ON DELETE CASCADE,
  repo VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL, -- 'issue', 'pr', 'commit'
  number INTEGER,
  commit_sha VARCHAR(40),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_links_slice ON slice_github_links(slice_id);
CREATE INDEX IF NOT EXISTS idx_github_links_repo ON slice_github_links(repo);
CREATE INDEX IF NOT EXISTS idx_github_links_type ON slice_github_links(type, number);

-- Store AI-enhanced analysis results
CREATE TABLE IF NOT EXISTS slice_ai_analysis (
  id SERIAL PRIMARY KEY,
  slice_id VARCHAR(36) REFERENCES code_slices(slice_id) ON DELETE CASCADE,
  conversation_id VARCHAR(255),
  analysis_type VARCHAR(50) NOT NULL, -- 'bug_fix', 'feature', 'review', 'doc'
  prompt TEXT NOT NULL,
  response TEXT NOT NULL,
  model VARCHAR(100),
  tokens_used INTEGER,
  cost_usd DECIMAL(10, 6),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_slice ON slice_ai_analysis(slice_id);
CREATE INDEX IF NOT EXISTS idx_ai_analysis_conversation ON slice_ai_analysis(conversation_id);

-- Statistics view for monitoring
CREATE OR REPLACE VIEW slice_stats_daily AS
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_slices,
  COUNT(DISTINCT repo) as unique_repos,
  AVG(duration_ms) as avg_duration_ms,
  AVG(files_analyzed) as avg_files,
  AVG(snippets_count) as avg_snippets,
  SUM(CASE WHEN duration_ms < 5000 THEN 1 ELSE 0 END)::FLOAT / COUNT(*) as success_rate
FROM code_slices
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- Statistics view by repository
CREATE OR REPLACE VIEW slice_stats_by_repo AS
SELECT 
  repo,
  COUNT(*) as total_slices,
  AVG(duration_ms) as avg_duration_ms,
  AVG(files_analyzed) as avg_files,
  MAX(created_at) as last_analyzed
FROM code_slices
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY repo
ORDER BY total_slices DESC;

-- Cleanup function for expired slices
CREATE OR REPLACE FUNCTION cleanup_expired_slices()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM code_slices WHERE expires_at < NOW();
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Create a cleanup job (requires pg_cron extension)
-- Uncomment if you have pg_cron installed:
-- SELECT cron.schedule('cleanup-expired-slices', '0 2 * * *', 'SELECT cleanup_expired_slices()');

-- Grant permissions
-- GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_app_user;
-- GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO your_app_user;

-- Sample data for testing (optional)
-- INSERT INTO code_slices (slice_id, repo, targets, context_lines, metadata)
-- VALUES (
--   gen_random_uuid()::text,
--   'owner/repo',
--   ARRAY['/api/users', '/api/posts'],
--   10,
--   '{"test": true}'::jsonb
-- );

COMMENT ON TABLE code_slices IS 'Stores code slice analysis results';
COMMENT ON TABLE slice_requests IS 'Tracks usage and performance of slice requests';
COMMENT ON TABLE slice_cache IS 'Caches slice results for faster retrieval';
COMMENT ON TABLE slice_github_links IS 'Links slices to GitHub issues, PRs, or commits';
COMMENT ON TABLE slice_ai_analysis IS 'Stores AI-enhanced analysis results from LLM Gateway';