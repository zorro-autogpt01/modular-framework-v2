const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
require('dotenv').config();

// Import routers
const reposRouter = require('./routes/repos');
const gitRouter = require('./routes/git');
const historyRouter = require('./routes/history');
const locksRouter = require('./routes/locks');
const workspaceRouter = require('./routes/workspace');
const settingsRouter = require('./routes/settings');
const aiRouter = require('./routes/ai');
const proxyRouter = require('./routes/proxy');  

// Import services
const WebSocketService = require('./services/websocket');
const FileWatcherService = require('./services/fileWatcher');
const SnapshotService = require('./services/snapshot');
const RedisService = require('./services/redis');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3006;
const WS_PORT = process.env.WS_PORT || 3007;

// Initialize HTTP server for WebSocket
const server = http.createServer(app);

// Middleware
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],

      // JS
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],   // allow inline on* handlers
      scriptSrcElem: ["'self'", "https://cdnjs.cloudflare.com"],

      // CSS
      styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrcElem: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],

      // Others
      imgSrc: ["'self'", "data:", "blob:"],
      fontSrc: ["'self'", "data:", "https://cdnjs.cloudflare.com"],
      connectSrc: ["'self'", "https:", "http:", "wss:", "ws:"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
    },
  },
}));
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(morgan('dev'));

// Static files (frontend)
app.use(express.static(path.join(__dirname, '../public')));

// API Routes
app.use('/api/repos', reposRouter);
app.use('/api/git', gitRouter);
app.use('/api/history', historyRouter);
app.use('/api/locks', locksRouter);
app.use('/api/workspace', workspaceRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/ai', aiRouter);
app.use('/api', proxyRouter); 

console.log('📝 Registered routes:');
console.log('   - /api/repos/*');
console.log('   - /api/git/*');
console.log('   - /api/history/*');
console.log('   - /api/locks/*');
console.log('   - /api/workspace/*');
console.log('   - /api/settings/*');
console.log('   - /api/ai/*');
console.log('   - /api/github-hub/* (proxy)');


// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy',
    service: 'code-workspace',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Add this route to get available workspaces from code-workspace
app.get('/api/workspaces', async (req, res) => {
  try {
    // Call code-workspace to get available repos
    const response = await axios.get(`${CODE_WORKSPACE_URL}/api/repos`);
    const repos = response.data;
    
    // Transform to connection/repo structure
    const workspaces = {};
    repos.forEach(repo => {
      const connId = repo.connection_id || 'default';
      if (!workspaces[connId]) {
        workspaces[connId] = [];
      }
      workspaces[connId].push(repo.name);
    });
    
    res.json(workspaces);
  } catch (error) {
    logger.error('Error fetching workspaces:', error);
    // Fall back to extracting from existing jobs
    const jobs = await jobQueue.getJobs({ limit: 100 });
    const workspaces = {};
    
    jobs.forEach(job => {
      if (job.targetFiles) {
        job.targetFiles.forEach(file => {
          if (!workspaces[file.connectionId]) {
            workspaces[file.connectionId] = new Set();
          }
          workspaces[file.connectionId].add(file.repoName);
        });
      }
    });
    
    // Convert Sets to arrays
    Object.keys(workspaces).forEach(key => {
      workspaces[key] = Array.from(workspaces[key]);
    });
    
    res.json(workspaces);
  }
});

// Initialize services
async function initializeServices() {
  try {
    // Connect to Redis
    await RedisService.connect();
    console.log('✅ Redis connected');

    // Initialize WebSocket server
    const wss = new WebSocket.Server({ port: WS_PORT });
    WebSocketService.initialize(wss);
    console.log(`✅ WebSocket server running on port ${WS_PORT}`);

    // Initialize file watcher
    FileWatcherService.initialize();
    console.log('✅ File watcher initialized');

    // Initialize snapshot service
    SnapshotService.initialize();
    console.log('✅ Snapshot service initialized');

    // Start Express server
    server.listen(PORT, () => {
      console.log(`✅ Code Workspace server running on port ${PORT}`);
      console.log(`📁 Workspace root: /workspace`);
      console.log(`🔗 GitHub Hub URL: ${process.env.GITHUB_HUB_URL || 'http://github-hub-module:3002'}`);
      console.log(`🤖 LLM Gateway URL: ${process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010'}`);
    });
  } catch (error) {
    console.error('❌ Failed to initialize services:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await RedisService.disconnect();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

// Start the server
initializeServices();

module.exports = app;
