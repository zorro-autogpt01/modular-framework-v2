// File Watcher Server
// Complete integration for File Watcher System

const express = require('express');
const http = require('http');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createSchema, createIndexes } = require('./database/database-schema');
const FileWatcherService = require('./services/file-watcher-service');
const WebSocketService = require('./services/websocket-service');
const fileWatcherRoutes = require('./routes/file-watcher-routes');

const app = express();
const PORT = process.env.PORT || 3042;
const REPOS_BASE_PATH = process.env.REPOS_PATH || '/workspace/repos';
const DB_PATH = process.env.DB_PATH || '/app/data/file-watcher.db';

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Create HTTP server
const server = http.createServer(app);

// These will be initialized after database is ready
let websocketService;
let fileWatcherService;
let db;

// Initialize database
const initDatabase = () => {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, async (err) => {
      if (err) {
        console.error('❌ Database connection error:', err);
        reject(err);
        return;
      }
      
      console.log('✅ Connected to SQLite database at', DB_PATH);
      
      try {
        await createSchema(db);
        await createIndexes(db);
        console.log('✅ Database schema initialized');
        resolve();
      } catch (error) {
        console.error('❌ Schema creation error:', error);
        reject(error);
      }
    });
  });
};

// Initialize services after database is ready
const initServices = () => {
  // Initialize WebSocket
  websocketService = new WebSocketService(server);
  
  // Initialize File Watcher Service with WebSocket
  fileWatcherService = new FileWatcherService(db, websocketService);
  
  // Register API routes
  app.use('/api/file-watcher', fileWatcherRoutes(db, fileWatcherService));
};

/**
 * Auto-discover and watch repositories
 */
async function autoDiscoverRepositories() {
  console.log('🔍 Auto-discovering repositories in', REPOS_BASE_PATH);
  
  try {
    const fs = require('fs').promises;
    
    // Check if repos directory exists
    const stats = await fs.stat(REPOS_BASE_PATH);
    if (!stats.isDirectory()) {
      console.warn('⚠️  REPOS_PATH is not a directory:', REPOS_BASE_PATH);
      return;
    }

    // List connections (subdirectories in repos)
    const connections = await fs.readdir(REPOS_BASE_PATH);
    
    let watchCount = 0;
    
    for (const connection of connections) {
      const connectionPath = path.join(REPOS_BASE_PATH, connection);
      const connectionStats = await fs.stat(connectionPath).catch(() => null);
      
      if (!connectionStats?.isDirectory()) continue;
      
      // List repositories for this connection
      const repos = await fs.readdir(connectionPath);
      
      for (const repo of repos) {
        const repoPath = path.join(connectionPath, repo);
        const repoStats = await fs.stat(repoPath).catch(() => null);
        
        if (!repoStats?.isDirectory()) continue;
        
        // Start watching this repository
        try {
          await fileWatcherService.startWatching(connection, repo, repoPath);
          console.log(`✅ Watching: ${connection}/${repo} at ${repoPath}`);
          watchCount++;
        } catch (error) {
          console.error(`❌ Failed to watch ${connection}/${repo}:`, error.message);
        }
      }
    }
    
    console.log(`\n🎯 Now watching ${watchCount} repositories`);
    
  } catch (error) {
    console.error('❌ Error discovering repositories:', error);
  }
}

/**
 * API to manually start watching a repository
 */
app.post('/api/repositories/:connection/:repo/watch', async (req, res) => {
  try {
    const { connection, repo } = req.params;
    let { repo_path } = req.body;
    
    // If no path provided, construct from base path
    if (!repo_path) {
      repo_path = path.join(REPOS_BASE_PATH, connection, repo);
    }
    
    // Verify path exists
    const fs = require('fs').promises;
    const stats = await fs.stat(repo_path).catch(() => null);
    if (!stats?.isDirectory()) {
      return res.status(400).json({
        success: false,
        error: 'Repository path does not exist or is not a directory',
        repo_path
      });
    }

    await fileWatcherService.startWatching(connection, repo, repo_path);

    res.json({
      success: true,
      message: `Started watching ${connection}/${repo}`,
      repo_path
    });
  } catch (error) {
    console.error('Error starting watcher:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * API to stop watching a repository
 */
app.post('/api/repositories/:connection/:repo/unwatch', async (req, res) => {
  try {
    const { connection, repo } = req.params;
    await fileWatcherService.stopWatching(connection, repo);

    res.json({
      success: true,
      message: `Stopped watching ${connection}/${repo}`
    });
  } catch (error) {
    console.error('Error stopping watcher:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get list of watched repositories
 */
app.get('/api/repositories/watching', (req, res) => {
  const watching = [];
  for (const key of fileWatcherService.watchers.keys()) {
    const [connection_id, repo_name] = key.split(':');
    watching.push({ connection_id, repo_name });
  }
  
  res.json({
    success: true,
    watching,
    count: watching.length
  });
});

/**
 * Get all repositories from database
 */
app.get('/api/repositories', async (req, res) => {
  try {
    // Get repos from database
    const sql = `
      SELECT DISTINCT connection_id, repo_name 
      FROM file_snapshots_batches 
      ORDER BY connection_id, repo_name
    `;
    
    db.all(sql, [], (err, dbRows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      // Get currently watched repos
      const watchedRepos = [];
      for (const key of fileWatcherService.watchers.keys()) {
        const [connection_id, repo_name] = key.split(':');
        watchedRepos.push({ connection_id, repo_name });
      }
      
      // Merge and deduplicate
      const repoMap = new Map();
      [...dbRows, ...watchedRepos].forEach(repo => {
        const key = `${repo.connection_id}:${repo.repo_name}`;
        repoMap.set(key, repo);
      });
      
      res.json(Array.from(repoMap.values()));
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get timeline data (API endpoint)
 */
app.get('/api/timeline/:connection/:repo', async (req, res) => {
  try {
    const { connection, repo } = req.params;
    
    const sql = `
      SELECT * FROM file_snapshots
      WHERE connection_id = ? AND repo_name = ?
      ORDER BY created_at DESC
      LIMIT 1000
    `;
    
    db.all(sql, [connection, repo], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        // Parse diff JSON strings
        const snapshots = rows.map(row => ({
          ...row,
          diff: row.diff ? JSON.parse(row.diff) : null
        }));
        
        res.json({ snapshots });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Get file history (API endpoint)
 */
app.get('/api/timeline/:connection/:repo/:filePath(*)', async (req, res) => {
  try {
    const { connection, repo, filePath } = req.params;
    
    const sql = `
      SELECT * FROM file_snapshots
      WHERE connection_id = ? AND repo_name = ? AND file_path = ?
      ORDER BY created_at DESC
      LIMIT 100
    `;
    
    db.all(sql, [connection, repo, filePath], (err, rows) => {
      if (err) {
        res.status(500).json({ error: err.message });
      } else {
        const history = rows.map(row => ({
          ...row,
          diff: row.diff ? JSON.parse(row.diff) : null
        }));
        
        res.json({ history });
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


/**
 * Rescan and watch new repositories
 */
app.post('/api/repositories/rescan', async (req, res) => {
  try {
    await autoDiscoverRepositories();
    
    const watching = [];
    for (const key of fileWatcherService.watchers.keys()) {
      const [connection_id, repo_name] = key.split(':');
      watching.push({ connection_id, repo_name });
    }
    
    res.json({
      success: true,
      message: 'Repository rescan complete',
      watching,
      count: watching.length
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Serve timeline UI
 */
app.get('/timeline/:connection/:repo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeline.html'));
});

/**
 * Serve timeline UI (no params - auto-select)
 */
app.get('/timeline', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeline.html'));
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    watchers: fileWatcherService ? fileWatcherService.watchers.size : 0,
    uptime: process.uptime(),
    reposPath: REPOS_BASE_PATH
  });
});

/**
 * Root endpoint with info
 */
app.get('/', (req, res) => {
  const watching = [];
  if (fileWatcherService) {
    for (const key of fileWatcherService.watchers.keys()) {
      const [connection_id, repo_name] = key.split(':');
      watching.push({ connection_id, repo_name });
    }
  }
  
  res.json({
    name: 'File Watcher Service',
    version: '1.0.0',
    status: 'running',
    watching: watching.length,
    repositories: watching,
    endpoints: {
      timeline: '/timeline/:connection/:repo',
      api: '/api/file-watcher/*',
      health: '/health',
      watching: '/api/repositories/watching',
      rescan: 'POST /api/repositories/rescan'
    }
  });
});

// Start server
const startServer = async () => {
  try {
    // Initialize database first
    await initDatabase();
    
    // Initialize services
    initServices();
    
    // Start HTTP server
    server.listen(PORT, async () => {
      console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║      File Watcher Service                             ║
║                                                       ║
║      🚀 Server running on http://localhost:${PORT}      ║
║      📁 Monitoring: ${REPOS_BASE_PATH}
║      📊 API: http://localhost:${PORT}/                   ║
║      💾 Database: ${DB_PATH}
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);

      // Auto-discover repositories after startup
      setTimeout(async () => {
        await autoDiscoverRepositories();
      }, 2000);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
};

// Graceful shutdown
const shutdown = async () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  
  // Stop accepting new connections
  server.close(() => {
    console.log('✅ HTTP server closed');
  });
  
  // Stop all watchers
  if (fileWatcherService) {
    await fileWatcherService.stopAll();
    console.log('✅ All watchers stopped');
  }
  
  // Close database
  if (db) {
    db.close((err) => {
      if (err) {
        console.error('❌ Error closing database:', err);
      } else {
        console.log('✅ Database closed');
      }
      
      console.log('👋 Goodbye!\n');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  shutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown();
});

// Start the server
startServer();

module.exports = app;