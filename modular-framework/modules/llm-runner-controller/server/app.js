// modules/llm-runner-controller/server/app.js
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');

const { requireAdmin, requireAdminOptional, requireReg, requireAgentAuth } = require('./auth');
const registry = require('./services/registry');
const health = require('./services/health');
const execProxy = require('./services/exec');
const configs = require('./services/configs');
const updates = require('./services/updates');
const events = require('./services/events');
const installers = require('./services/installers');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json({ limit: '2mb' }));

app.get('/health', (_req,res)=> res.json({status:'healthy'}));

// SSE Events
app.get('/api/llm-runner/events', events.sse);

// Agents
app.get('/api/llm-runner/agents', requireAdminOptional, registry.list);
app.post('/api/llm-runner/agents', requireAdmin, registry.upsert);
app.post('/api/llm-runner/agents/register', requireReg, registry.selfRegister);
app.get('/api/llm-runner/agents/:id', requireAdminOptional, registry.get);
app.delete('/api/llm-runner/agents/:id', requireAdmin, registry.remove);
app.post('/api/llm-runner/agents/:id/ping', requireAdmin, health.pingNow);
app.get('/api/llm-runner/agents/:id/health', requireAdmin, health.proxy);
app.post('/api/llm-runner/agents/:id/exec', requireAdmin, execProxy.run);

// Catalog (discovery)
app.get('/api/llm-runner/catalog', registry.catalog);

// Configs
app.get('/api/llm-runner/configs', requireAdmin, configs.list);
app.post('/api/llm-runner/configs', requireAdmin, configs.create);
app.post('/api/llm-runner/agents/:id/configs/assign', requireAdmin, configs.assign);
app.get('/api/llm-runner/agents/:id/configs/effective', requireAdmin, configs.effective);
// agent-friendly pull (auth with agent token)
app.get('/api/llm-runner/agents/:id/configs/pull', requireAgentAuth, configs.pullForAgent);

// Updates
app.post('/api/llm-runner/agents/:id/update', requireAdmin, updates.trigger);
app.get('/api/llm-runner/updates/:updId', requireAdmin, updates.get);

// Installers
app.get('/install/runner.sh', (req,res)=> installers.dockerScript(req,res));
app.get('/install/systemd.sh', (req,res)=> installers.systemdScript(req,res));

// Static (optional public docs later)
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Start health scheduler
health.startScheduler();

module.exports = app;
