// Example Server
// Complete integration example for File Watcher System

const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { createSchema, createIndexes } = require('./database-schema');
const FileWatcherService = require('./file-watcher-service');
const fileWatcherRoutes = require('./file-watcher-routes');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files (timeline-ui.html, .js, .css)

// Initialize database
const db = new sqlite3.Database('./file-watcher.db', async (err) => {
  if (err) {
    console.error('❌ Database connection error:', err);
    process.exit(1);
  }
  
  console.log('✅ Connected to SQLite database');
  
  try {
    // Create schema
    await createSchema(db);
    await createIndexes(db);
    console.log('✅ Database schema initialized');
  } catch (error) {
    console.error('❌ Schema creation error:', error);
    process.exit(1);
  }
});

// Initialize File Watcher Service
const fileWatcherService = new FileWatcherService(db);

// Register API routes
app.use('/api/file-watcher', fileWatcherRoutes(db, fileWatcherService));

// Example: API to start watching a repository
app.post('/api/repositories/:connection/:repo/watch', async (req, res) => {
  try {
    const { connection, repo } = req.params;
    const { repo_path } = req.body;
    
    if (!repo_path) {
      return res.status(400).json({
        success: false,
        error: 'repo_path is required'
      });
    }

    await fileWatcherService.startWatching(connection, repo, repo_path);

    res.json({
      success: true,
      message: `Started watching ${connection}:${repo}`,
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

// Example: API to stop watching a repository
app.post('/api/repositories/:connection/:repo/unwatch', async (req, res) => {
  try {
    const { connection, repo } = req.params;

    await fileWatcherService.stopWatching(connection, repo);

    res.json({
      success: true,
      message: `Stopped watching ${connection}:${repo}`
    });
  } catch (error) {
    console.error('Error stopping watcher:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Example: Get list of watched repositories
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

// Serve timeline UI
app.get('/timeline/:connection/:repo', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'timeline-ui.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    watchers: fileWatcherService.watchers.size,
    uptime: process.uptime()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════╗
║                                                       ║
║      File Watcher System Server                       ║
║                                                       ║
║      🚀 Server running on http://localhost:${PORT}      ║
║      📊 Health check: /health                         ║
║      📁 Timeline UI: /timeline/:connection/:repo      ║
║      📡 API: /api/file-watcher/*                      ║
║                                                       ║
╚═══════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n\n🛑 Shutting down gracefully...');
  
  // Stop all watchers
  await fileWatcherService.stopAll();
  console.log('✅ All watchers stopped');
  
  // Close database
  db.close((err) => {
    if (err) {
      console.error('❌ Error closing database:', err);
    } else {
      console.log('✅ Database closed');
    }
    
    console.log('👋 Goodbye!\n');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  await fileWatcherService.stopAll();
  db.close();
  process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Example usage (comment out in production):
// Automatically watch a test repository on startup
setTimeout(async () => {
  // Example: Watch a test repository
  // Uncomment and modify for your use case:
  
  /*
  const testRepoPath = '/path/to/your/test/repo';
  await fileWatcherService.startWatching(
    'test-connection',
    'test-repo',
    testRepoPath
  );
  console.log(`✅ Started watching test repository: ${testRepoPath}`);
  console.log(`   View timeline at: http://localhost:${PORT}/timeline/test-connection/test-repo`);
  */
}, 1000);

module.exports = app;