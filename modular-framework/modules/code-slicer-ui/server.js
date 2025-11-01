// Code Slicer UI Server
// Serves the web interface and proxies requests to backend services

const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3030;

// Configuration
const CODE_SLICER_URL = process.env.CODE_SLICER_URL || 'http://localhost:3025/api';
const LLM_GATEWAY_URL = process.env.LLM_GATEWAY_URL || 'http://localhost:3010/api';
const AI_ASSISTANT_URL = process.env.AI_ASSISTANT_URL || 'http://localhost:3035/api';
const GITHUB_HUB_URL = process.env.GITHUB_HUB_URL || 'http://localhost:3002/api';

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// Serve the UI
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        service: 'code-slicer-ui',
        version: '1.0.0',
        backends: {
            code_slicer: CODE_SLICER_URL,
            llm_gateway: LLM_GATEWAY_URL,
            ai_assistant: AI_ASSISTANT_URL,
            github_hub: GITHUB_HUB_URL
        }
    });
});

// Proxy to Code Slicer Service
app.use('/api/slice', async (req, res) => {
    try {
        const url = `${CODE_SLICER_URL}${req.path}`;
        
        const config = {
            method: req.method,
            url,
            headers: {
                'Content-Type': 'application/json'
            },
            params: req.query
        };
        
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            config.data = req.body;
        }
        
        const response = await axios(config);
        res.status(response.status).json(response.data);
        
    } catch (error) {
        console.error('Code Slicer proxy error:', error.message);
        
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ 
                error: 'Code Slicer service unavailable',
                details: error.message 
            });
        }
    }
});

// Proxy to LLM Gateway
app.post('/api/llm/*', async (req, res) => {
    try {
        const path = req.params[0];
        const url = `${LLM_GATEWAY_URL}/${path}`;
        
        console.log(`Proxying to LLM Gateway: ${url}`);
        
        const response = await axios.post(url, req.body, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 60000 // 60 second timeout for LLM
        });
        
        res.status(response.status).json(response.data);
        
    } catch (error) {
        console.error('LLM Gateway proxy error:', error.message);
        
        if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ 
                error: 'LLM Gateway unavailable',
                details: error.message 
            });
        }
    }
});

// Proxy to AI Assistant (if available)
app.post('/api/assist', async (req, res) => {
    try {
        const response = await axios.post(`${AI_ASSISTANT_URL}/assist`, req.body, {
            headers: {
                'Content-Type': 'application/json'
            },
            timeout: 90000 // 90 second timeout
        });
        
        res.status(response.status).json(response.data);
        
    } catch (error) {
        console.error('AI Assistant proxy error:', error.message);
        
        // If AI Assistant is not available, return error so frontend can fallback
        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
            res.status(503).json({ 
                error: 'AI Assistant service not available',
                fallback: true
            });
        } else if (error.response) {
            res.status(error.response.status).json(error.response.data);
        } else {
            res.status(500).json({ 
                error: 'AI Assistant error',
                details: error.message 
            });
        }
    }
});

// Get connected repositories from GitHub Hub
// List connected repositories (normalized for UI)
app.get('/api/repos', async (req, res) => {
  try {
    const { data } = await axios.get(`${GITHUB_HUB_URL}/connections`);
    const connections = data?.connections || [];

    const repositories = connections.map(conn => {
      // derive owner/name from repo_url (strip .git if present)
      const repoUrl = conn.repo_url || '';
      const parts = repoUrl.replace(/\.git$/, '').split('/');
      const owner = parts[parts.length - 2] || null;
      const name = parts[parts.length - 1] || null;
      const full_name = owner && name ? `${owner}/${name}` : null;

      return {
        owner,
        name,
        full_name,
        connection_id: conn.id,
        repo_url: conn.repo_url,
        default_branch: conn.default_branch || 'main'
      };
    });

    res.json({
      default_connection_id: data?.default_id || null,
      repositories
    });
  } catch (error) {
    console.error('Failed to fetch repos:', error.message);
    res.status(500).json({
      error: 'Failed to fetch repositories',
      details: error.message,
      hint: 'Make sure GitHub Hub is running and has connections configured'
    });
  }
});

// Get branches for a connection (uses conn_id per spec)
app.get('/api/repos/:connId/branches', async (req, res) => {
  try {
    const { connId } = req.params;
    const { data } = await axios.get(`${GITHUB_HUB_URL}/branches`, {
      params: { conn_id: connId }
    });

    const branches = data?.branches || [];
    res.json({ branches });
  } catch (error) {
    console.error('Failed to fetch branches:', error.message);

    if (error.response) {
      res.status(error.response.status).json(error.response.data);
    } else {
      // Conservative defaults if GH Hub is unreachable
      res.json({
        branches: ['main', 'master', 'develop'],
        note: 'Using default branches, GitHub Hub not reachable'
      });
    }
  }
});

// Get available LLM models
// Get available LLM models (expose db_id + key + model_name for gateway requests)
app.get('/api/models', async (req, res) => {
  try {
    const response = await axios.get(`${LLM_GATEWAY_URL}/models`);

    const items = response.data.items || [];

    const models = items.map(m => ({
      // for dropdown value we keep a stable string, but return all fields we need
      id: (m.key && m.key.length) ? m.key : m.model_name, // dropdown value
      name: m.display_name || m.model_name,               // label
      provider: m.provider_name || m.provider,            // optional
      // IMPORTANT: pass-through fields for the client to call the gateway correctly
      db_id: m.id,                                        // numeric primary key
      key: m.key || null,                                 // gateway modelKey
      model_name: m.model_name,                           // fallback 'model'
    }));

    if (models.length === 0) {
      return res.json({
        models: [
          { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', db_id: null, key: 'claude-sonnet-4', model_name: 'claude-sonnet-4' },
          { id: 'gpt-4',           name: 'GPT-4',          provider: 'openai',     db_id: null, key: 'gpt-4',           model_name: 'gpt-4' }
        ],
        note: 'Using default models - no models configured in LLM Gateway'
      });
    }

    res.json({ models });
  } catch (error) {
    console.error('Failed to fetch models:', error.message);
    res.json({
      models: [
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', db_id: null, key: 'claude-sonnet-4', model_name: 'claude-sonnet-4' },
        { id: 'gpt-4',           name: 'GPT-4',          provider: 'openai',     db_id: null, key: 'gpt-4',           model_name: 'gpt-4' }
      ],
      note: 'Using default models - LLM Gateway not available'
    });
  }
});


// Error handling
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ 
        error: 'Internal server error',
        details: err.message 
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║                   🔬 Code Slicer UI                            ║
╠════════════════════════════════════════════════════════════════╣
║  Web Interface:    http://localhost:${PORT}                       ║
║                                                                ║
║  Backend Services:                                             ║
║  📊 Code Slicer:   ${CODE_SLICER_URL.padEnd(42)} ║
║  🧠 LLM Gateway:   ${LLM_GATEWAY_URL.padEnd(42)} ║
║  🤖 AI Assistant:  ${AI_ASSISTANT_URL.padEnd(42)} ║
╚════════════════════════════════════════════════════════════════╝
    `);
    
    console.log('✨ Features:');
    console.log('  • Manual code analysis');
    console.log('  • AI-powered chat assistant');
    console.log('  • GitHub issue/PR integration');
    console.log('  • Branch management');
    console.log('  • Real-time LLM integration');
    console.log('');
    console.log('🚀 Ready to analyze code!');
    console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});

module.exports = app;