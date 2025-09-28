const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PGHOST || 'postgres',
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'llm_gateway',
  max: 10
});

const ENC_KEY = process.env.CONFIG_ENCRYPTION_KEY || null;

async function q(text, params) {
  const client = await pool.connect();
  try { return await client.query(text, params); }
  finally { client.release(); }
}

async function initDb() {
  // Enable pgcrypto (once)
  await q(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);

  // Global config: single row (id=1)
  await q(`
    CREATE TABLE IF NOT EXISTS chat_global_config (
      id SMALLINT PRIMARY KEY DEFAULT 1,
      provider TEXT,
      base_url TEXT,
      api_key_enc BYTEA,
      api_key_plain TEXT,
      model TEXT,
      temperature NUMERIC,
      max_tokens INTEGER,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);

  // Profiles: named
  await q(`
    CREATE TABLE IF NOT EXISTS chat_profiles (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      provider TEXT,
      base_url TEXT,
      api_key_enc BYTEA,
      api_key_plain TEXT,
      model TEXT,
      temperature NUMERIC,
      max_tokens INTEGER,
      system_prompt TEXT,
      updated_at TIMESTAMP DEFAULT now()
    );
  `);
}

/* ===== Global config ===== */
async function readGlobalConfig() {
  const sql = `
    SELECT
      provider, base_url, model, temperature, max_tokens,
      CASE
        WHEN $1::text IS NOT NULL AND api_key_enc IS NOT NULL THEN (pgp_sym_decrypt(api_key_enc, $1))::text
        ELSE api_key_plain
      END AS api_key
    FROM chat_global_config WHERE id=1
  `;
  const { rows } = await q(sql, [ENC_KEY]);
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    provider: r.provider || 'openai',
    baseUrl: r.base_url || 'https://api.openai.com',
    apiKey: r.api_key || '',
    model: r.model || 'gpt-4o-mini',
    temperature: r.temperature != null ? Number(r.temperature) : 0.7,
    max_tokens: r.max_tokens != null ? Number(r.max_tokens) : undefined
  };
}

async function writeGlobalConfig(cfg) {
  const {
    provider, baseUrl, apiKey, model, temperature, max_tokens
  } = cfg || {};
  if (ENC_KEY) {
    await q(`
      INSERT INTO chat_global_config(id, provider, base_url, api_key_enc, api_key_plain, model, temperature, max_tokens, updated_at)
      VALUES (1, $1, $2, pgp_sym_encrypt($3, $4), NULL, $5, $6, $7, now())
      ON CONFLICT (id) DO UPDATE
      SET provider=EXCLUDED.provider,
          base_url=EXCLUDED.base_url,
          api_key_enc=EXCLUDED.api_key_enc,
          api_key_plain=NULL,
          model=EXCLUDED.model,
          temperature=EXCLUDED.temperature,
          max_tokens=EXCLUDED.max_tokens,
          updated_at=now()
    `, [provider, baseUrl, apiKey || '', ENC_KEY, model, temperature, max_tokens]);
  } else {
    await q(`
      INSERT INTO chat_global_config(id, provider, base_url, api_key_enc, api_key_plain, model, temperature, max_tokens, updated_at)
      VALUES (1, $1, $2, NULL, $3, $4, $5, $6, now())
      ON CONFLICT (id) DO UPDATE
      SET provider=EXCLUDED.provider,
          base_url=EXCLUDED.base_url,
          api_key_enc=NULL,
          api_key_plain=EXCLUDED.api_key_plain,
          model=EXCLUDED.model,
          temperature=EXCLUDED.temperature,
          max_tokens=EXCLUDED.max_tokens,
          updated_at=now()
    `, [provider, baseUrl, apiKey || '', model, temperature, max_tokens]);
  }
  return await readGlobalConfig();
}

/* ===== Profiles ===== */
function mapRowToProfile(r) {
  return {
    name: r.name,
    provider: r.provider || undefined,
    baseUrl: r.base_url || undefined,
    apiKey: r.api_key || undefined,
    model: r.model || undefined,
    temperature: r.temperature != null ? Number(r.temperature) : undefined,
    max_tokens: r.max_tokens != null ? Number(r.max_tokens) : undefined,
    systemPrompt: r.system_prompt || ''
  };
}
async function listProfiles() {
  const sql = `
    SELECT
      name, provider, base_url, model, temperature, max_tokens, system_prompt,
      CASE
        WHEN $1::text IS NOT NULL AND api_key_enc IS NOT NULL THEN (pgp_sym_decrypt(api_key_enc, $1))::text
        ELSE api_key_plain
      END AS api_key
    FROM chat_profiles
    ORDER BY name ASC
  `;
  const { rows } = await q(sql, [ENC_KEY]);
  return rows.map(mapRowToProfile);
}

async function replaceAllProfiles(arr = []) {
  // transactional replace
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chat_profiles');
    for (const p of arr) {
      const {
        name, provider, baseUrl, apiKey, model, temperature, max_tokens, systemPrompt
      } = p || {};
      if (!name) continue;
      if (ENC_KEY) {
        await client.query(`
          INSERT INTO chat_profiles(name, provider, base_url, api_key_enc, api_key_plain, model, temperature, max_tokens, system_prompt, updated_at)
          VALUES ($1,$2,$3, pgp_sym_encrypt($4,$5), NULL, $6,$7,$8,$9, now())
        `, [name, provider || null, baseUrl || null, apiKey || '', ENC_KEY, model || null, temperature || null, max_tokens || null, systemPrompt || '']);
      } else {
        await client.query(`
          INSERT INTO chat_profiles(name, provider, base_url, api_key_enc, api_key_plain, model, temperature, max_tokens, system_prompt, updated_at)
          VALUES ($1,$2,$3, NULL, $4, $5,$6,$7,$8, now())
        `, [name, provider || null, baseUrl || null, apiKey || '', model || null, temperature || null, max_tokens || null, systemPrompt || '']);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    client.release();
  }
  return await listProfiles();
}

module.exports = {
  initDb,
  readGlobalConfig, writeGlobalConfig,
  listProfiles, replaceAllProfiles
};
