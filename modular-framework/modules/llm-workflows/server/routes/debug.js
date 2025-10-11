// modular-framework/modules/llm-workflows/server/routes/debug.js
const express = require('express');
const router = express.Router();
const { logs } = require('../logger');

/**
 * Get filtered logs with search capability
 */
router.get('/debug/logs', (req, res) => {
  const { 
    level, 
    search, 
    corr, 
    limit = 500,
    format = 'json'
  } = req.query;
  
  let filtered = [...logs];
  
  // Filter by level
  if (level) {
    filtered = filtered.filter(log => log.level === level);
  }
  
  // Filter by correlation ID
  if (corr) {
    filtered = filtered.filter(log => 
      log.meta?.corr === corr || 
      log.meta?.correlation_id === corr ||
      JSON.stringify(log).includes(corr)
    );
  }
  
  // Search in log content
  if (search) {
    const searchLower = search.toLowerCase();
    filtered = filtered.filter(log => 
      log.msg?.toLowerCase().includes(searchLower) ||
      JSON.stringify(log.meta || {}).toLowerCase().includes(searchLower)
    );
  }
  
  // Limit results
  const maxLimit = Math.min(Number(limit), 2000);
  filtered = filtered.slice(-maxLimit);
  
  if (format === 'text') {
    const text = filtered.map(log => 
      `[${log.ts}] [${log.level.toUpperCase()}] ${log.msg}\n${
        log.meta ? '  ' + JSON.stringify(log.meta, null, 2) : ''
      }`
    ).join('\n\n');
    
    res.setHeader('Content-Type', 'text/plain');
    res.send(text);
  } else {
    res.json({ 
      count: filtered.length,
      logs: filtered 
    });
  }
});

/**
 * Get logs for a specific workflow run
 */
router.get('/debug/runs/:id/logs', (req, res) => {
  const { id } = req.params;
  const { format = 'json' } = req.query;
  
  const runLogs = logs.filter(log => 
    log.meta?.run_id === id ||
    log.meta?.corr === id ||
    JSON.stringify(log).includes(id)
  );
  
  if (format === 'text') {
    const text = runLogs.map(log => 
      `[${log.ts}] [${log.level.toUpperCase()}] ${log.msg}\n${
        log.meta ? '  ' + JSON.stringify(log.meta, null, 2) : ''
      }`
    ).join('\n\n');
    
    res.setHeader('Content-Type', 'text/plain');
    res.send(text);
  } else {
    res.json({ 
      run_id: id,
      count: runLogs.length,
      logs: runLogs 
    });
  }
});

/**
 * Get real-time log stream (SSE)
 */
router.get('/debug/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  const { level, search } = req.query;
  let lastIndex = logs.length;
  
  // Send initial logs
  const initial = logs.slice(-50);
  res.write(`data: ${JSON.stringify({ type: 'initial', logs: initial })}\n\n`);
  
  // Stream new logs
  const interval = setInterval(() => {
    const newLogs = logs.slice(lastIndex);
    lastIndex = logs.length;
    
    if (newLogs.length > 0) {
      let filtered = newLogs;
      
      if (level) {
        filtered = filtered.filter(log => log.level === level);
      }
      
      if (search) {
        const searchLower = search.toLowerCase();
        filtered = filtered.filter(log => 
          log.msg?.toLowerCase().includes(searchLower) ||
          JSON.stringify(log.meta || {}).toLowerCase().includes(searchLower)
        );
      }
      
      if (filtered.length > 0) {
        res.write(`data: ${JSON.stringify({ type: 'update', logs: filtered })}\n\n`);
      }
    }
  }, 1000);
  
  req.on('close', () => {
    clearInterval(interval);
  });
});

module.exports = { router };