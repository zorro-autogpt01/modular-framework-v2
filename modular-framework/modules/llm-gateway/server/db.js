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
  await q(`
    CREATE TABLE IF NOT EXISTS providers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL CHECK (kind IN ('openai','openai-compatible','ollama')),
      base_url TEXT NOT NULL,
      api_key TEXT,           -- plaintext for now
      headers JSONB,          -- optional additional headers
      created_at TIMESTAMP DEFAULT now()
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS models (
      id SERIAL PRIMARY KEY,
      provider_id INTEGER REFERENCES providers(id) ON DELETE CASCADE,
      key TEXT UNIQUE,                 -- e.g. "openai:gpt-4o-mini"
      model_name TEXT NOT NULL,        -- upstream identifier (e.g. gpt-4o-mini)
      display_name TEXT,
      mode TEXT NOT NULL DEFAULT 'auto',  -- 'auto' | 'chat' | 'responses'
      supports_responses BOOLEAN DEFAULT false,
      supports_reasoning BOOLEAN DEFAULT false,
      input_cost_per_million NUMERIC(12,6) DEFAULT 0,   -- USD
      output_cost_per_million NUMERIC(12,6) DEFAULT 0,  -- USD
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
}

async function listProviders() {
  const { rows } = await q('SELECT * FROM providers ORDER BY id ASC'); return rows;
}
async function getProvider(id) {
  const { rows } = await q('SELECT * FROM providers WHERE id=$1', [id]); return rows[0];
}
async function createProvider(p) {
  const { rows } = await q(
    `INSERT INTO providers(name, kind, base_url, api_key, headers) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [p.name, p.kind, p.base_url, p.api_key || null, p.headers || null]
  );
  return rows[0];
}
async function updateProvider(id, p) {
  const { rows } = await q(
    `UPDATE providers SET name=$1, kind=$2, base_url=$3, api_key=$4, headers=$5 WHERE id=$6 RETURNING *`,
    [p.name, p.kind, p.base_url, p.api_key || null, p.headers || null, id]
  );
  return rows[0];
}
async function deleteProvider(id) { await q('DELETE FROM providers WHERE id=$1', [id]); }

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
    SELECT m.*, p.name as provider_name, p.kind as provider_kind, p.base_url as provider_base_url, p.api_key as provider_api_key, p.headers as provider_headers, p.id as provider_id
    FROM models m
    LEFT JOIN providers p ON p.id=m.provider_id
    WHERE m.id=$1
  `, [id]);
  return rows[0];
}
async function getModelByKey(key) {
  const { rows } = await q(`
    SELECT m.*, p.name as provider_name, p.kind as provider_kind, p.base_url as provider_base_url, p.api_key as provider_api_key, p.headers as provider_headers, p.id as provider_id
    FROM models m LEFT JOIN providers p ON p.id=m.provider_id
    WHERE m.key=$1
  `, [key]);
  return rows[0];
}
async function getModelByName(model_name) {
  const { rows } = await q(`
    SELECT m.*, p.name as provider_name, p.kind as provider_kind, p.base_url as provider_base_url, p.api_key as provider_api_key, p.headers as provider_headers, p.id as provider_id
    FROM models m LEFT JOIN providers p ON p.id=m.provider_id
    WHERE m.model_name=$1
    LIMIT 1
  `, [model_name]);
  return rows[0];
}
async function createModel(m) {
  const { rows } = await q(`
    INSERT INTO models(provider_id, key, model_name, display_name, mode, supports_responses, supports_reasoning, input_cost_per_million, output_cost_per_million, currency)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *`,
    [
      m.provider_id, m.key || null, m.model_name, m.display_name || null, m.mode || 'auto',
      !!m.supports_responses, !!m.supports_reasoning,
      m.input_cost_per_million || 0, m.output_cost_per_million || 0, m.currency || 'USD'
    ]
  );
  return rows[0];
}
async function updateModel(id, m) {
  const { rows } = await q(`
    UPDATE models
    SET provider_id=$1, key=$2, model_name=$3, display_name=$4, mode=$5, supports_responses=$6, supports_reasoning=$7, input_cost_per_million=$8, output_cost_per_million=$9, currency=$10
    WHERE id=$11 RETURNING *`,
    [
      m.provider_id, m.key || null, m.model_name, m.display_name || null, m.mode || 'auto',
      !!m.supports_responses, !!m.supports_reasoning,
      m.input_cost_per_million || 0, m.output_cost_per_million || 0, m.currency || 'USD',
      id
    ]
  );
  return rows[0];
}
async function deleteModel(id) { await q('DELETE FROM models WHERE id=$1', [id]); }

async function logUsage(u) {
  const { rows } = await q(`
    INSERT INTO usage_log(provider_id, model_id, conversation_id, input_tokens, output_tokens, prompt_chars, completion_chars, cost, meta)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
  `, [
    u.provider_id || null, u.model_id || null, u.conversation_id || null,
    u.input_tokens || null, u.output_tokens || null,
    u.prompt_chars || null, u.completion_chars || null,
    u.cost || null,
    u.meta || null
  ]);
  return rows[0];
}
async function recentUsage(limit = 200) {
  const lim = Math.max(1, Math.min(Number(limit || 200), 2000));
  const { rows } = await q('SELECT * FROM usage_log ORDER BY id DESC LIMIT $1', [lim]);
  return rows;
}

module.exports = {
  initDb, q,
  listProviders, getProvider, createProvider, updateProvider, deleteProvider,
  listModels, getModel, getModelByKey, getModelByName, createModel, updateModel, deleteModel,
  logUsage, recentUsage
};

