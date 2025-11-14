const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const RedisService = require('../services/redis');
const WebSocketService = require('../services/websocket');

const LOCK_TTL = 3600; // 1 hour default TTL for locks

// Get all locks for a repository
router.get('/:connection_id/:repo_name', async (req, res) => {
  const { connection_id, repo_name } = req.params;

  try {
    const pattern = `lock:${connection_id}:${repo_name}:*`;
    const keys = await RedisService.keys(pattern);
    
    const locks = [];
    for (const key of keys) {
      const lockData = await RedisService.get(key);
      if (lockData) {
        const lock = JSON.parse(lockData);
        const ttl = await RedisService.ttl(key);
        locks.push({
          ...lock,
          ttl,
          expired: ttl < 0
        });
      }
    }

    res.json({ locks });
  } catch (error) {
    console.error('Error getting locks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Acquire a lock on a file
router.post('/:connection_id/:repo_name/acquire', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { 
    file, 
    owner, 
    container_id = 'unknown',
    ttl = LOCK_TTL,
    force = false 
  } = req.body;

  if (!file || !owner) {
    return res.status(400).json({ error: 'File and owner are required' });
  }

  try {
    const lockKey = `lock:${connection_id}:${repo_name}:${file}`;
    const lockId = uuidv4();
    
    // Check if lock exists
    const existingLock = await RedisService.get(lockKey);
    
    if (existingLock && !force) {
      const lock = JSON.parse(existingLock);
      return res.status(409).json({ 
        error: 'File is already locked',
        lock
      });
    }

    // Create lock
    const lockData = {
      id: lockId,
      file,
      owner,
      container_id,
      acquired_at: new Date().toISOString(),
      connection_id,
      repo_name
    };

    await RedisService.setex(lockKey, ttl, JSON.stringify(lockData));

    // Broadcast lock acquired
    WebSocketService.broadcast({
      type: 'lock:acquired',
      data: lockData
    });

    res.json({
      success: true,
      lock: lockData,
      ttl
    });
  } catch (error) {
    console.error('Error acquiring lock:', error);
    res.status(500).json({ error: error.message });
  }
});

// Release a lock
router.delete('/:connection_id/:repo_name/release', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { file, owner, lock_id, force = false } = req.body;

  if (!file) {
    return res.status(400).json({ error: 'File is required' });
  }

  try {
    const lockKey = `lock:${connection_id}:${repo_name}:${file}`;
    const existingLock = await RedisService.get(lockKey);
    
    if (!existingLock) {
      return res.status(404).json({ error: 'Lock not found' });
    }

    const lock = JSON.parse(existingLock);
    
    // Verify ownership unless forced
    if (!force && lock.owner !== owner && lock.id !== lock_id) {
      return res.status(403).json({ error: 'Not authorized to release this lock' });
    }

    // Release lock
    await RedisService.del(lockKey);

    // Broadcast lock released
    WebSocketService.broadcast({
      type: 'lock:released',
      data: {
        file,
        connection_id,
        repo_name,
        released_by: owner
      }
    });

    res.json({
      success: true,
      message: 'Lock released successfully'
    });
  } catch (error) {
    console.error('Error releasing lock:', error);
    res.status(500).json({ error: error.message });
  }
});

// Extend lock TTL
router.post('/:connection_id/:repo_name/extend', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { file, owner, lock_id, ttl = LOCK_TTL } = req.body;

  if (!file) {
    return res.status(400).json({ error: 'File is required' });
  }

  try {
    const lockKey = `lock:${connection_id}:${repo_name}:${file}`;
    const existingLock = await RedisService.get(lockKey);
    
    if (!existingLock) {
      return res.status(404).json({ error: 'Lock not found' });
    }

    const lock = JSON.parse(existingLock);
    
    // Verify ownership
    if (lock.owner !== owner && lock.id !== lock_id) {
      return res.status(403).json({ error: 'Not authorized to extend this lock' });
    }

    // Extend TTL
    await RedisService.expire(lockKey, ttl);

    // Broadcast lock extended
    WebSocketService.broadcast({
      type: 'lock:extended',
      data: {
        file,
        connection_id,
        repo_name,
        ttl,
        extended_by: owner
      }
    });

    res.json({
      success: true,
      ttl,
      message: 'Lock extended successfully'
    });
  } catch (error) {
    console.error('Error extending lock:', error);
    res.status(500).json({ error: error.message });
  }
});

// Check if file is locked
router.get('/:connection_id/:repo_name/check/:file', async (req, res) => {
  const { connection_id, repo_name, file } = req.params;
  
  try {
    const lockKey = `lock:${connection_id}:${repo_name}:${decodeURIComponent(file)}`;
    const lockData = await RedisService.get(lockKey);
    
    if (!lockData) {
      return res.json({ locked: false });
    }

    const lock = JSON.parse(lockData);
    const ttl = await RedisService.ttl(lockKey);
    
    res.json({
      locked: true,
      lock,
      ttl
    });
  } catch (error) {
    console.error('Error checking lock:', error);
    res.status(500).json({ error: error.message });
  }
});

// Bulk check multiple files
router.post('/:connection_id/:repo_name/check-bulk', async (req, res) => {
  const { connection_id, repo_name } = req.params;
  const { files = [] } = req.body;

  try {
    const results = {};
    
    for (const file of files) {
      const lockKey = `lock:${connection_id}:${repo_name}:${file}`;
      const lockData = await RedisService.get(lockKey);
      
      if (lockData) {
        const lock = JSON.parse(lockData);
        const ttl = await RedisService.ttl(lockKey);
        results[file] = { locked: true, lock, ttl };
      } else {
        results[file] = { locked: false };
      }
    }

    res.json({ results });
  } catch (error) {
    console.error('Error bulk checking locks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Clean up expired locks (maintenance endpoint)
router.post('/cleanup', async (req, res) => {
  try {
    const pattern = 'lock:*';
    const keys = await RedisService.keys(pattern);
    
    let cleaned = 0;
    for (const key of keys) {
      const ttl = await RedisService.ttl(key);
      if (ttl === -2) { // Key doesn't exist
        cleaned++;
      }
    }

    res.json({
      success: true,
      cleaned,
      message: `Cleaned up ${cleaned} expired locks`
    });
  } catch (error) {
    console.error('Error cleaning up locks:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
