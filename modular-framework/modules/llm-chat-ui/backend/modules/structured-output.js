/**
 * STRUCTURED OUTPUT MODULE
 * 
 * JSON schema management and structured output validation.
 * Enables forcing LLM responses into specific formats.
 */

const { q } = require('../db');
const Ajv = require('ajv'); // You'll need: npm install ajv

const ajv = new Ajv({ allErrors: true });

const version = '1.0.0';
const description = 'Structured output and schema validation';
const endpoints = [
  'GET /api/schemas',
  'POST /api/schemas',
  'GET /api/schemas/:id',
  'PUT /api/schemas/:id',
  'DELETE /api/schemas/:id',
  'POST /api/schemas/validate',
  'POST /api/schemas/generate',
  'POST /api/schemas/from-example'
];

async function initialize() {
  return true;
}

// ========== SCHEMA MANAGEMENT ==========

async function listSchemas({ category = null, tags = null, is_public = null } = {}) {
  let query = 'SELECT * FROM output_schemas WHERE 1=1';
  const params = [];
  
  if (category) {
    query += ` AND category = $${params.length + 1}`;
    params.push(category);
  }
  
  if (tags && tags.length > 0) {
    query += ` AND tags && $${params.length + 1}`;
    params.push(tags);
  }
  
  if (is_public !== null) {
    query += ` AND is_public = $${params.length + 1}`;
    params.push(is_public);
  }
  
  query += ' ORDER BY is_system DESC, usage_count DESC, name ASC';
  
  const { rows } = await q(query, params);
  return rows;
}

async function getSchema(id) {
  const { rows } = await q(
    'SELECT * FROM output_schemas WHERE id = $1',
    [id]
  );
  return rows[0];
}

async function getSchemaByName(name) {
  const { rows } = await q(
    'SELECT * FROM output_schemas WHERE name = $1 ORDER BY created_at DESC LIMIT 1',
    [name]
  );
  return rows[0];
}

async function createSchema(schema) {
  // Validate the schema definition itself
  try {
    ajv.compile(schema.schema_definition);
  } catch (error) {
    throw new Error(`Invalid JSON Schema: ${error.message}`);
  }

  const { rows } = await q(`
    INSERT INTO output_schemas(
      name, description, schema_definition, category,
      tags, validation_mode, created_by, is_public
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [
    schema.name,
    schema.description || null,
    schema.schema_definition,
    schema.category || null,
    schema.tags || [],
    schema.validation_mode || 'strict',
    schema.created_by || null,
    schema.is_public || false
  ]);
  
  return rows[0];
}

async function updateSchema(id, updates) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (updates.description !== undefined) {
    fields.push(`description = $${idx++}`);
    values.push(updates.description);
  }
  
  if (updates.schema_definition !== undefined) {
    // Validate new schema
    try {
      ajv.compile(updates.schema_definition);
    } catch (error) {
      throw new Error(`Invalid JSON Schema: ${error.message}`);
    }
    fields.push(`schema_definition = $${idx++}`);
    values.push(updates.schema_definition);
  }
  
  if (updates.category !== undefined) {
    fields.push(`category = $${idx++}`);
    values.push(updates.category);
  }
  
  if (updates.tags !== undefined) {
    fields.push(`tags = $${idx++}`);
    values.push(updates.tags);
  }
  
  if (updates.validation_mode !== undefined) {
    fields.push(`validation_mode = $${idx++}`);
    values.push(updates.validation_mode);
  }

  if (fields.length === 0) {
    return getSchema(id);
  }

  fields.push(`updated_at = now()`);
  values.push(id);

  const { rows } = await q(`
    UPDATE output_schemas
    SET ${fields.join(', ')}
    WHERE id = $${idx}
    RETURNING *
  `, values);

  return rows[0];
}

async function deleteSchema(id) {
  const schema = await getSchema(id);
  if (schema && schema.is_system) {
    throw new Error('Cannot delete system schema');
  }
  
  await q('DELETE FROM output_schemas WHERE id = $1', [id]);
}

// ========== VALIDATION ==========

async function validateData(schemaId, data) {
  const schema = await getSchema(schemaId);
  if (!schema) {
    throw new Error('Schema not found');
  }

  const validate = ajv.compile(schema.schema_definition);
  const valid = validate(data);

  const result = {
    valid,
    schema_id: schemaId,
    validation_mode: schema.validation_mode,
    errors: valid ? null : validate.errors
  };

  // Record validation attempt
  await recordValidation(schemaId, valid, validate.errors);

  return result;
}

async function recordValidation(schemaId, passed, errors) {
  await q(`
    INSERT INTO schema_usage(schema_id, validation_passed, validation_errors)
    VALUES ($1, $2, $3)
  `, [schemaId, passed, errors ? JSON.stringify(errors) : null]);
  
  // Update schema stats
  await q(`
    UPDATE output_schemas
    SET usage_count = usage_count + 1,
        avg_validation_success = (
          SELECT AVG(CASE WHEN validation_passed THEN 1.0 ELSE 0.0 END)
          FROM schema_usage
          WHERE schema_id = $1
        )
    WHERE id = $1
  `, [schemaId]);
}

// ========== STRUCTURED RESPONSE ==========

async function saveStructuredResponse(messageId, schemaId, data) {
  const validation = await validateData(schemaId, data);
  
  const { rows } = await q(`
    INSERT INTO structured_responses(
      message_id, schema_id, data, validation_status, validation_errors
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `, [
    messageId,
    schemaId,
    data,
    validation.valid ? 'valid' : 'invalid',
    validation.errors ? JSON.stringify(validation.errors) : null
  ]);

  return rows[0];
}

async function getStructuredResponse(messageId) {
  const { rows } = await q(`
    SELECT sr.*, os.name as schema_name, os.schema_definition
    FROM structured_responses sr
    JOIN output_schemas os ON os.id = sr.schema_id
    WHERE sr.message_id = $1
  `, [messageId]);
  
  return rows[0];
}

// ========== AI-ASSISTED SCHEMA GENERATION ==========

/**
 * Generate schema from natural language description
 * In production, this would call LLM to generate schema
 */
async function generateSchemaFromDescription(description) {
  // Placeholder - would call LLM in production
  // For now, return a basic template
  return {
    type: 'object',
    description: description,
    properties: {
      data: {
        type: 'object',
        description: 'Generated based on: ' + description
      }
    },
    required: ['data']
  };
}

/**
 * Infer schema from example data
 */
function inferSchemaFromExample(example) {
  function inferType(value) {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) {
      if (value.length === 0) {
        return { type: 'array', items: {} };
      }
      return {
        type: 'array',
        items: inferType(value[0])
      };
    }
    if (typeof value === 'object') {
      const properties = {};
      const required = [];
      for (const [key, val] of Object.entries(value)) {
        properties[key] = inferType(val);
        required.push(key);
      }
      return {
        type: 'object',
        properties,
        required
      };
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) 
        ? { type: 'integer' }
        : { type: 'number' };
    }
    if (typeof value === 'boolean') return { type: 'boolean' };
    if (typeof value === 'string') {
      // Check for common formats
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        return { type: 'string', format: 'date-time' };
      }
      if (/^https?:\/\//.test(value)) {
        return { type: 'string', format: 'uri' };
      }
      return { type: 'string' };
    }
    return {};
  }

  try {
    const data = typeof example === 'string' ? JSON.parse(example) : example;
    return inferType(data);
  } catch (error) {
    throw new Error(`Invalid JSON example: ${error.message}`);
  }
}

// ========== DATA TRANSFORMATION ==========

const transformers = {
  toCSV: (data) => {
    // Simple CSV transformation
    if (!Array.isArray(data)) data = [data];
    if (data.length === 0) return '';
    
    const keys = Object.keys(data[0]);
    const header = keys.join(',');
    const rows = data.map(obj => keys.map(k => JSON.stringify(obj[k] || '')).join(','));
    return [header, ...rows].join('\n');
  },
  
  toMarkdown: (data) => {
    if (!Array.isArray(data)) data = [data];
    if (data.length === 0) return '';
    
    const keys = Object.keys(data[0]);
    const header = `| ${keys.join(' | ')} |`;
    const separator = `| ${keys.map(() => '---').join(' | ')} |`;
    const rows = data.map(obj => `| ${keys.map(k => obj[k] || '').join(' | ')} |`);
    return [header, separator, ...rows].join('\n');
  },
  
  toSQL: (data, tableName = 'data') => {
    if (!Array.isArray(data)) data = [data];
    return data.map(obj => {
      const keys = Object.keys(obj);
      const values = keys.map(k => JSON.stringify(obj[k]));
      return `INSERT INTO ${tableName} (${keys.join(', ')}) VALUES (${values.join(', ')});`;
    }).join('\n');
  }
};

async function transformData(data, format) {
  const transformer = transformers[format];
  if (!transformer) {
    throw new Error(`Unknown transformation format: ${format}`);
  }
  return transformer(data);
}

module.exports = {
  version,
  description,
  endpoints,
  initialize,
  
  // Schema management
  listSchemas,
  getSchema,
  getSchemaByName,
  createSchema,
  updateSchema,
  deleteSchema,
  
  // Validation
  validateData,
  
  // Structured responses
  saveStructuredResponse,
  getStructuredResponse,
  
  // AI-assisted generation
  generateSchemaFromDescription,
  inferSchemaFromExample,
  
  // Transformation
  transformData
};
