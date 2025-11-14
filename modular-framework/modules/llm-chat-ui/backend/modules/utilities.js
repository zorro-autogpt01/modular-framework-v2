/**
 * TEMPLATES MODULE
 */

const { q } = require('../db');

const templates = {
  version: '1.0.0',
  description: 'Prompt template management',
  endpoints: [
    'GET /api/templates',
    'POST /api/templates',
    'GET /api/templates/:id',
    'PUT /api/templates/:id',
    'POST /api/templates/:id/render'
  ],

  async initialize() { return true; },

  async listTemplates({ archived = false, category = null, tags = null } = {}) {
    let query = 'SELECT * FROM prompt_templates WHERE archived = $1';
    const params = [archived];
    
    if (category) {
      query += ` AND category = $${params.length + 1}`;
      params.push(category);
    }
    
    if (tags && tags.length > 0) {
      query += ` AND tags && $${params.length + 1}`;
      params.push(tags);
    }
    
    query += ' ORDER BY usage_count DESC, name ASC';
    
    const { rows } = await q(query, params);
    return rows;
  },

  async getTemplate(id) {
    const { rows } = await q('SELECT * FROM prompt_templates WHERE id = $1', [id]);
    return rows[0];
  },

  async getTemplateByName(name, version = null) {
    let query = 'SELECT * FROM prompt_templates WHERE name = $1';
    const params = [name];
    
    if (version) {
      query += ' AND version = $2';
      params.push(version);
    } else {
      query += ' ORDER BY version DESC LIMIT 1';
    }
    
    const { rows } = await q(query, params);
    return rows[0];
  },

  async createTemplate(template) {
    const { rows: existing } = await q(
      'SELECT MAX(version) as max_v FROM prompt_templates WHERE name = $1',
      [template.name]
    );
    const nextVersion = (existing[0]?.max_v || 0) + 1;

    const { rows } = await q(`
      INSERT INTO prompt_templates(
        name, version, template, variables, description,
        category, tags, personality_id, schema_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [
      template.name, nextVersion, template.template,
      template.variables || null, template.description || null,
      template.category || null, template.tags || [],
      template.personality_id || null, template.schema_id || null,
      template.created_by || null
    ]);
    
    return rows[0];
  },

  async renderTemplate(templateId, variables = {}) {
    const template = await templates.getTemplate(templateId);
    if (!template) throw new Error('Template not found');
    
    let rendered = template.template;
    const varsUsed = {};
    
    // Simple {{variable}} replacement
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      if (regex.test(rendered)) {
        rendered = rendered.replace(regex, value);
        varsUsed[key] = value;
      }
    }
    
    // Track usage
    await q(
      'UPDATE prompt_templates SET usage_count = usage_count + 1 WHERE id = $1',
      [templateId]
    );
    
    return { template, rendered, variables_used: varsUsed };
  }
};

/**
 * SMART ACTIONS MODULE
 */

const smartActions = {
  version: '1.0.0',
  description: 'Pre-configured smart action buttons',
  endpoints: [
    'GET /api/actions',
    'POST /api/actions',
    'POST /api/actions/:name/execute'
  ],

  async initialize() { return true; },

  async listActions({ category = null, enabled = true } = {}) {
    let query = 'SELECT * FROM smart_actions WHERE is_enabled = $1';
    const params = [enabled];
    
    if (category) {
      query += ` AND category = $${params.length + 1}`;
      params.push(category);
    }
    
    query += ' ORDER BY is_system DESC, usage_count DESC, name ASC';
    
    const { rows } = await q(query, params);
    return rows;
  },

  async getAction(name) {
    const { rows } = await q('SELECT * FROM smart_actions WHERE name = $1', [name]);
    return rows[0];
  },

  async createAction(action) {
    const { rows } = await q(`
      INSERT INTO smart_actions(
        name, label, description, category, icon,
        action_type, config, personality_id, schema_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      action.name, action.label, action.description || null,
      action.category || 'custom', action.icon || null,
      action.action_type, action.config,
      action.personality_id || null, action.schema_id || null
    ]);
    
    return rows[0];
  },

  async executeAction(name, context = {}) {
    const action = await smartActions.getAction(name);
    if (!action) throw new Error('Action not found');
    
    // Track usage
    await q(
      'UPDATE smart_actions SET usage_count = usage_count + 1 WHERE name = $1',
      [name]
    );
    
    // Execute based on action type
    const result = { action: name, type: action.action_type };
    
    switch (action.action_type) {
      case 'prompt':
        result.generated_prompt = action.config.prompt + '\n\n' + (context.content || '');
        break;
      case 'transformation':
        result.transformation_type = action.config.extract_type || action.config.transform_type;
        break;
      case 'api_call':
        result.endpoint = action.config.endpoint;
        result.method = action.config.method || 'POST';
        break;
      case 'workflow':
        result.workflow_id = action.config.workflow_id;
        break;
    }
    
    return result;
  }
};

/**
 * WORKFLOWS MODULE
 */

const workflows = {
  version: '1.0.0',
  description: 'Multi-step workflow orchestration',
  endpoints: [
    'GET /api/workflows',
    'POST /api/workflows',
    'POST /api/workflows/:id/execute'
  ],

  async initialize() { return true; },

  async listWorkflows({ tags = null } = {}) {
    let query = 'SELECT * FROM output_workflows WHERE 1=1';
    const params = [];
    
    if (tags && tags.length > 0) {
      query += ` AND tags && $${params.length + 1}`;
      params.push(tags);
    }
    
    query += ' ORDER BY usage_count DESC, name ASC';
    
    const { rows } = await q(query, params);
    return rows;
  },

  async getWorkflow(id) {
    const { rows } = await q('SELECT * FROM output_workflows WHERE id = $1', [id]);
    return rows[0];
  },

  async createWorkflow(workflow) {
    const { rows } = await q(`
      INSERT INTO output_workflows(
        name, description, steps, tags, created_by
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [
      workflow.name,
      workflow.description || null,
      workflow.steps,
      workflow.tags || [],
      workflow.created_by || null
    ]);
    
    return rows[0];
  },

  async executeWorkflow(workflowId, context = {}) {
    const workflow = await workflows.getWorkflow(workflowId);
    if (!workflow) throw new Error('Workflow not found');
    
    const startTime = Date.now();
    const results = [];
    
    try {
      for (const step of workflow.steps) {
        const stepResult = {
          step: step.name,
          status: 'pending'
        };
        
        // Execute step based on type
        // In production, this would actually run the step
        stepResult.status = 'completed';
        stepResult.output = `Step ${step.name} completed`;
        
        results.push(stepResult);
      }
      
      // Track success
      const duration = Math.floor((Date.now() - startTime) / 1000);
      await q(`
        UPDATE output_workflows
        SET usage_count = usage_count + 1,
            avg_duration_seconds = COALESCE(
              ((avg_duration_seconds * usage_count) + $2) / (usage_count + 1),
              $2
            ),
            success_rate = COALESCE(
              ((success_rate * usage_count) + 1.0) / (usage_count + 1),
              1.0
            )
        WHERE id = $1
      `, [workflowId, duration]);
      
      return { workflow_id: workflowId, status: 'completed', results, duration };
    } catch (error) {
      return { workflow_id: workflowId, status: 'failed', error: error.message, results };
    }
  }
};

/**
 * ANALYTICS MODULE
 */

const analytics = {
  version: '1.0.0',
  description: 'Usage analytics and insights',
  endpoints: [
    'GET /api/analytics/messages',
    'GET /api/analytics/conversations',
    'GET /api/analytics/personalities',
    'GET /api/analytics/schemas'
  ],

  async initialize() { return true; },

  async getMessageAnalytics(messageId) {
    const { rows } = await q(
      'SELECT * FROM message_analytics WHERE message_id = $1',
      [messageId]
    );
    return rows[0];
  },

  async recordMessageAnalytics(data) {
    const { rows } = await q(`
      INSERT INTO message_analytics(
        message_id, conversation_id, personality_id, schema_id,
        user_rating, time_to_response_ms
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [
      data.message_id,
      data.conversation_id,
      data.personality_id || null,
      data.schema_id || null,
      data.user_rating || null,
      data.time_to_response_ms || null
    ]);
    
    return rows[0];
  },

  async rateMessage(messageId, rating) {
    if (rating < 1 || rating > 5) {
      throw new Error('Rating must be between 1 and 5');
    }
    
    const existing = await analytics.getMessageAnalytics(messageId);
    
    if (existing) {
      await q(
        'UPDATE message_analytics SET user_rating = $1 WHERE message_id = $2',
        [rating, messageId]
      );
    } else {
      await analytics.recordMessageAnalytics({ message_id: messageId, user_rating: rating });
    }
  },

  async getConversationStats(conversationId) {
    const { rows } = await q(`
      SELECT
        COUNT(*) as total_messages,
        COUNT(CASE WHEN role = 'user' THEN 1 END) as user_messages,
        COUNT(CASE WHEN role = 'assistant' THEN 1 END) as assistant_messages,
        SUM(tokens) as total_tokens,
        SUM(cost) as total_cost,
        AVG(ma.user_rating) as avg_rating
      FROM conversation_messages cm
      LEFT JOIN message_analytics ma ON ma.message_id = cm.id
      WHERE cm.conversation_id = $1
    `, [conversationId]);
    
    return rows[0];
  },

  async getPersonalityStats() {
    const { rows } = await q(`
      SELECT
        pp.id, pp.name, pp.usage_count, pp.avg_rating,
        COUNT(c.id) as conversation_count,
        AVG(ma.user_rating) as actual_avg_rating
      FROM personality_profiles pp
      LEFT JOIN conversations c ON c.personality_id = pp.id
      LEFT JOIN conversation_messages cm ON cm.conversation_id = c.id
      LEFT JOIN message_analytics ma ON ma.message_id = cm.id
      GROUP BY pp.id
      ORDER BY pp.usage_count DESC
      LIMIT 50
    `);
    
    return rows;
  },

  async getSchemaStats() {
    const { rows } = await q(`
      SELECT
        os.id, os.name, os.category, os.usage_count, os.avg_validation_success,
        COUNT(sr.id) as response_count,
        COUNT(CASE WHEN sr.validation_status = 'valid' THEN 1 END) as valid_count
      FROM output_schemas os
      LEFT JOIN structured_responses sr ON sr.schema_id = os.id
      GROUP BY os.id
      ORDER BY os.usage_count DESC
      LIMIT 50
    `);
    
    return rows;
  }
};

module.exports = {
  templates,
  smartActions,
  workflows,
  analytics
};
