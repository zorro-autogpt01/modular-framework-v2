const express = require('express');
const cors = require('cors');
const db = require('./db-extended');

const app = express();
const PORT = process.env.PORT || 3020;
const LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://localhost:3010';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ========== Health Check ==========
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'llm-chat-ui' });
});

// ========== Conversation Management ==========

// Get conversation with branches and goal
app.get('/api/conversations/:id/full', async (req, res) => {
  try {
    const convId = req.params.id;
    
    // Get conversation from gateway
    const convResp = await fetch(`${LLM_GATEWAY_URL}/api/conversations/${convId}`);
    if (!convResp.ok) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const { conversation } = await convResp.json();
    
    // Get branches
    const branches = await db.getBranches(convId);
    
    // Get goal
    const goal = await db.getConversationGoal(convId);
    
    // Get personality if set
    let personality = null;
    if (conversation.personality_id) {
      personality = await db.getPersonality(conversation.personality_id);
    }
    
    res.json({
      conversation,
      branches,
      goal,
      personality
    });
  } catch (error) {
    console.error('Error fetching full conversation:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Branches ==========

app.post('/api/branches', async (req, res) => {
  try {
    const branch = await db.createBranch(req.body);
    res.json({ ok: true, branch });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/branches', async (req, res) => {
  try {
    const branches = await db.getBranches(req.params.id);
    res.json({ branches });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/branches/:id/activate', async (req, res) => {
  try {
    const branch = await db.getBranch(req.params.id);
    if (!branch) {
      return res.status(404).json({ error: 'Branch not found' });
    }
    
    await db.setActiveBranch(branch.conversation_id, req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/branches/:id', async (req, res) => {
  try {
    const branch = await db.updateBranch(req.params.id, req.body);
    res.json({ ok: true, branch });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/branches/:id', async (req, res) => {
  try {
    await db.deleteBranch(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/branches/:id/messages', async (req, res) => {
  try {
    const { limit, before } = req.query;
    const messages = await db.getBranchMessages(req.params.id, { limit, before });
    res.json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Goals ==========

app.get('/api/conversations/:id/goal', async (req, res) => {
  try {
    const goal = await db.getConversationGoal(req.params.id);
    res.json({ goal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/conversations/:id/goal', async (req, res) => {
  try {
    const goal = await db.createConversationGoal({
      conversation_id: req.params.id,
      ...req.body
    });
    res.json({ ok: true, goal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/goals/:id', async (req, res) => {
  try {
    const goal = await db.updateConversationGoal(req.params.id, req.body);
    res.json({ ok: true, goal });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Message Metadata ==========

app.put('/api/messages/:id/metadata', async (req, res) => {
  try {
    const metadata = await db.upsertMessageMetadata(req.params.id, req.body);
    res.json({ ok: true, metadata });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Personalities ==========

app.get('/api/personalities', async (req, res) => {
  try {
    const personalities = await db.listPersonalities();
    res.json({ personalities });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/personalities/:id', async (req, res) => {
  try {
    const personality = await db.getPersonality(req.params.id);
    if (!personality) {
      return res.status(404).json({ error: 'Personality not found' });
    }
    res.json({ personality });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/personalities', async (req, res) => {
  try {
    const personality = await db.createPersonality(req.body);
    res.json({ ok: true, personality });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/personalities/:id', async (req, res) => {
  try {
    const personality = await db.updatePersonality(req.params.id, req.body);
    res.json({ ok: true, personality });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/personalities/:id', async (req, res) => {
  try {
    await db.deletePersonality(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Output Schemas ==========

app.get('/api/schemas', async (req, res) => {
  try {
    const { category, tags } = req.query;
    const tagArray = tags ? tags.split(',') : null;
    const schemas = await db.listSchemas({ category, tags: tagArray });
    res.json({ schemas });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/schemas/:id', async (req, res) => {
  try {
    const schema = await db.getSchema(req.params.id);
    if (!schema) {
      return res.status(404).json({ error: 'Schema not found' });
    }
    res.json({ schema });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/schemas', async (req, res) => {
  try {
    const schema = await db.createSchema(req.body);
    res.json({ ok: true, schema });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/schemas/:id', async (req, res) => {
  try {
    const schema = await db.updateSchema(req.params.id, req.body);
    res.json({ ok: true, schema });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/schemas/:id', async (req, res) => {
  try {
    await db.deleteSchema(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Smart Actions ==========

app.get('/api/actions', async (req, res) => {
  try {
    const { category } = req.query;
    const actions = await db.listSmartActions(category);
    res.json({ actions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/actions/:id/use', async (req, res) => {
  try {
    await db.incrementActionUsage(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Prompt Advisor ==========

app.post('/api/advisor/suggest', async (req, res) => {
  try {
    const { conversation_id, goal, branches, current_branch, message_history } = req.body;
    
    // Use LLM to generate suggestions based on goal and context
    const suggestions = await generateSuggestions({
      conversation_id,
      goal,
      branches,
      current_branch,
      message_history
    });
    
    // Save to database
    await db.saveAdvisorSuggestion({
      conversation_id,
      goal_id: goal?.id,
      suggestion_type: 'next_prompt',
      suggestions
    });
    
    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/conversations/:id/suggestions', async (req, res) => {
  try {
    const suggestions = await db.getAdvisorSuggestions(req.params.id);
    res.json({ suggestions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Schema Generation (AI-Assisted) ==========

app.post('/api/schemas/generate', async (req, res) => {
  try {
    const { description, example_data } = req.body;
    
    // Use LLM to generate schema
    const prompt = `Generate a JSON Schema based on this description: ${description}
${example_data ? `Example data: ${JSON.stringify(example_data)}` : ''}

Return ONLY a valid JSON Schema object with no additional text.`;

    const response = await fetch(`${LLM_GATEWAY_URL}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error('Failed to generate schema');
    }

    const data = await response.json();
    let schemaText = data.content || '';
    
    // Clean up response
    schemaText = schemaText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const schema = JSON.parse(schemaText);
    
    res.json({ ok: true, schema });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Context Management ==========

app.post('/api/context/optimize', async (req, res) => {
  try {
    const { branch_id, max_tokens, strategy } = req.body;
    
    const messages = await db.getContextMessages(branch_id, max_tokens);
    
    res.json({
      ok: true,
      included_messages: messages.length,
      total_tokens: messages.reduce((sum, m) => sum + (m.tokens || 0), 0)
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== User Preferences ==========

app.get('/api/users/:id/preferences', async (req, res) => {
  try {
    const prefs = await db.getUserPreferences(req.params.id);
    res.json({ preferences: prefs || {} });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/users/:id/preferences', async (req, res) => {
  try {
    const prefs = await db.upsertUserPreferences(req.params.id, req.body);
    res.json({ ok: true, preferences: prefs });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ========== Chat Proxy (Enhanced) ==========

app.post('/api/chat', async (req, res) => {
  try {
    const { 
      conversation_id, 
      branch_id, 
      personality_id, 
      schema_id,
      message,
      ...gatewayParams 
    } = req.body;
    
    // Get personality if specified
    let systemPrompt = null;
    if (personality_id) {
      const personality = await db.getPersonality(personality_id);
      if (personality) {
        systemPrompt = personality.system_prompt;
        await db.incrementPersonalityUsage(personality_id);
      }
    }
    
    // Get schema if specified
    let schemaInstructions = '';
    if (schema_id) {
      const schema = await db.getSchema(schema_id);
      if (schema) {
        schemaInstructions = `\n\nRespond with ONLY valid JSON matching this schema:\n${JSON.stringify(schema.schema_definition, null, 2)}`;
        await db.incrementSchemaUsage(schema_id);
      }
    }
    
    // Build messages array
    const messages = [...(gatewayParams.messages || [])];
    
    // Prepend system prompt if personality is set
    if (systemPrompt) {
      messages.unshift({
        role: 'system',
        content: systemPrompt + schemaInstructions
      });
    } else if (schemaInstructions) {
      messages.unshift({
        role: 'system',
        content: 'You are a helpful assistant.' + schemaInstructions
      });
    }
    
    // Add user message
    if (message) {
      messages.push({ role: 'user', content: message });
    }
    
    // Forward to LLM Gateway
    const response = await fetch(`${LLM_GATEWAY_URL}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...gatewayParams,
        messages,
        conversation_id
      })
    });
    
    if (!response.ok) {
      throw new Error(`Gateway error: ${response.statusText}`);
    }
    
    // Stream or return response
    if (gatewayParams.stream !== false) {
      res.setHeader('Content-Type', 'text/event-stream');
      response.body.pipe(res);
    } else {
      const data = await response.json();
      
      // If schema validation is enabled, validate response
      if (schema_id) {
        // TODO: Add JSON Schema validation here
        // For now, just try to parse as JSON
        try {
          const jsonData = JSON.parse(data.content);
          
          // Save structured response
          // We'd need the message_id here, which would come from the gateway response
          // This is simplified for now
          
          res.json({ ...data, structured_data: jsonData });
        } catch (e) {
          res.json({ ...data, validation_error: 'Response is not valid JSON' });
        }
      } else {
        res.json(data);
      }
    }
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========== Helper Functions ==========

async function generateSuggestions({ conversation_id, goal, branches, current_branch, message_history }) {
  // Use LLM to generate intelligent suggestions
  const goalText = goal?.goal_text || 'No specific goal set';
  const progress = goal?.progress || 0;
  
  const prompt = `You are an AI prompt advisor. Based on the conversation context, suggest 3-5 next prompts.

Current Goal: ${goalText}
Progress: ${progress}%

Recent messages:
${message_history.slice(-5).map(m => `${m.role}: ${m.content?.substring(0, 100)}...`).join('\n')}

Generate suggestions as a JSON array with this format:
[
  {
    "title": "Short title",
    "prompt": "The actual prompt text",
    "rationale": "Why this is suggested",
    "estimated_exchanges": 3,
    "path_type": "direct|thorough|alternative|validate"
  }
]

Return ONLY the JSON array, no other text.`;

  try {
    const response = await fetch(`${LLM_GATEWAY_URL}/api/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
        stream: false
      })
    });

    const data = await response.json();
    let text = data.content || '[]';
    text = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    return JSON.parse(text);
  } catch (error) {
    console.error('Error generating suggestions:', error);
    // Return fallback suggestions
    return [
      {
        title: 'Continue',
        prompt: 'Continue with the next step',
        rationale: 'Natural progression',
        estimated_exchanges: 2,
        path_type: 'direct'
      }
    ];
  }
}

// Start server
app.listen(PORT, () => {
  console.log(`LLM Chat UI Backend running on port ${PORT}`);
  console.log(`LLM Gateway URL: ${LLM_GATEWAY_URL}`);
});
