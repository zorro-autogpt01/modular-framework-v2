/**
 * PERSONALITIES MODULE
 * 
 * LLM personality/persona management.
 * Different assistant personalities for different tasks.
 */

const { q } = require('../db');

const version = '1.0.0';
const description = 'LLM personality and persona management';
const endpoints = [
  'GET /api/personalities',
  'POST /api/personalities',
  'GET /api/personalities/:id',
  'PUT /api/personalities/:id',
  'DELETE /api/personalities/:id'
];

async function initialize() {
  return true;
}

async function listPersonalities({ is_public = null, tags = null } = {}) {
  let query = 'SELECT * FROM personality_profiles WHERE 1=1';
  const params = [];
  
  if (is_public !== null) {
    query += ` AND is_public = $${params.length + 1}`;
    params.push(is_public);
  }
  
  if (tags && tags.length > 0) {
    query += ` AND tags && $${params.length + 1}`;
    params.push(tags);
  }
  
  query += ' ORDER BY is_system DESC, usage_count DESC, name ASC';
  
  const { rows } = await q(query, params);
  return rows;
}

async function getPersonality(id) {
  const { rows } = await q(
    'SELECT * FROM personality_profiles WHERE id = $1',
    [id]
  );
  return rows[0];
}

async function getPersonalityByName(name) {
  const { rows } = await q(
    'SELECT * FROM personality_profiles WHERE name = $1',
    [name]
  );
  return rows[0];
}

async function createPersonality(personality) {
  const { rows } = await q(`
    INSERT INTO personality_profiles(
      name, description, system_prompt, model_preference,
      temperature, max_tokens, response_style, tags,
      created_by, is_public
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *
  `, [
    personality.name,
    personality.description || null,
    personality.system_prompt,
    personality.model_preference || null,
    personality.temperature || 0.7,
    personality.max_tokens || 2000,
    personality.response_style || null,
    personality.tags || [],
    personality.created_by || null,
    personality.is_public || false
  ]);
  
  return rows[0];
}

async function updatePersonality(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  const allowedFields = [
    'description', 'system_prompt', 'model_preference',
    'temperature', 'max_tokens', 'response_style', 'tags'
  ];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = $${idx++}`);
      values.push(updates[field]);
    }
  }

  if (fields.length === 0) {
    return getPersonality(id);
  }

  fields.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await q(`
    UPDATE personality_profiles
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING *
  `, values);

  return rows[0];
}

async function deletePersonality(id) {
  // Prevent deletion of system personalities
  const personality = await getPersonality(id);
  if (personality && personality.is_system) {
    throw new Error('Cannot delete system personality');
  }
  
  await q('DELETE FROM personality_profiles WHERE id = $1', [id]);
}

async function incrementUsageCount(id) {
  await q(
    'UPDATE personality_profiles SET usage_count = usage_count + 1 WHERE id = $1',
    [id]
  );
}

async function ratePersonality(id, rating) {
  if (rating < 1 || rating > 5) {
    throw new Error('Rating must be between 1 and 5');
  }
  
  await q(`
    UPDATE personality_profiles
    SET avg_rating = CASE
      WHEN avg_rating IS NULL THEN $2
      ELSE ((avg_rating * usage_count) + $2) / (usage_count + 1)
    END
    WHERE id = $1
  `, [id, rating]);
}

module.exports = {
  version,
  description,
  endpoints,
  initialize,
  listPersonalities,
  getPersonality,
  getPersonalityByName,
  createPersonality,
  updatePersonality,
  deletePersonality,
  incrementUsageCount,
  ratePersonality
};
