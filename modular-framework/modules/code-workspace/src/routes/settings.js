const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const RedisService = require('../services/redis');

const SETTINGS_FILE = '/app/data/settings.json';

// Default settings
const DEFAULT_SETTINGS = {
  git: {
    defaultBranch: 'main',
    autoFetch: true,
    fetchInterval: 300, // 5 minutes
    commitTemplate: 'conventional', // conventional, simple, detailed
    signCommits: false
  },
  snapshots: {
    maxPerRepo: 250,
    retentionDays: 30,
    autoSnapshot: true,
    snapshotOnPull: true,
    snapshotOnPush: true,
    snapshotOnMerge: true
  },
  ai: {
    enabled: true,
    llmGatewayUrl: process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010',
    model: 'gpt-4o',
    features: {
      commitMessages: true,
      prePushAnalysis: true,
      pullSummaries: true,
      tokenCounting: true,
      codeReview: false,
      conflictResolution: true
    },
    commitStyle: 'conventional', // conventional, simple, detailed
    temperature: 0.7,
    maxTokens: 500
  },
  workspace: {
    defaultCloneDepth: 0, // 0 = full clone
    cloneSubmodules: true,
    enableLFS: true,
    fileWatcherEnabled: true,
    lockTTL: 3600, // 1 hour
    maxFileSize: 104857600, // 100MB
    excludePatterns: [
      'node_modules',
      '.git',
      'dist',
      'build',
      '*.log',
      '.env'
    ]
  },
  ui: {
    theme: 'auto', // light, dark, auto
    language: 'en',
    dateFormat: 'relative', // relative, absolute
    showLineNumbers: true,
    syntaxHighlighting: true,
    diffView: 'split', // split, unified
    fileTreeView: 'tree', // tree, list
    autoSave: false,
    autoSaveInterval: 30 // seconds
  },
  integrations: {
    githubHub: {
      url: process.env.GITHUB_HUB_URL || 'http://github-hub-module:3002/api',
      enabled: true,
      syncConnections: true
    },
    webhooks: {
      enabled: false,
      endpoints: []
    },
    notifications: {
      enabled: true,
      channels: ['websocket', 'email'],
      events: {
        pushComplete: true,
        pullComplete: true,
        mergeConflict: true,
        snapshotCreated: false,
        lockAcquired: false
      }
    }
  }
};

// Get current settings
router.get('/', async (req, res) => {
  try {
    // Try to load from file
    let settings = DEFAULT_SETTINGS;
    try {
      const data = await fs.readFile(SETTINGS_FILE, 'utf8');
      settings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    } catch {
      // File doesn't exist, use defaults
    }

    // Override with environment variables
    if (process.env.MAX_SNAPSHOTS_PER_REPO) {
      settings.snapshots.maxPerRepo = parseInt(process.env.MAX_SNAPSHOTS_PER_REPO);
    }
    if (process.env.SNAPSHOT_RETENTION_DAYS) {
      settings.snapshots.retentionDays = parseInt(process.env.SNAPSHOT_RETENTION_DAYS);
    }
    if (process.env.LLM_GATEWAY_URL) {
      settings.ai.llmGatewayUrl = process.env.LLM_GATEWAY_URL;
    }
    if (process.env.GITHUB_HUB_URL) {
      settings.integrations.githubHub.url = process.env.GITHUB_HUB_URL;
    }

    res.json(settings);
  } catch (error) {
    console.error('Error getting settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update settings
router.put('/', async (req, res) => {
  try {
    // Load current settings
    let currentSettings = DEFAULT_SETTINGS;
    try {
      const data = await fs.readFile(SETTINGS_FILE, 'utf8');
      currentSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
    } catch {
      // File doesn't exist, use defaults
    }

    // Merge with new settings
    const newSettings = deepMerge(currentSettings, req.body);

    // Validate settings
    const validation = validateSettings(newSettings);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Invalid settings',
        errors: validation.errors
      });
    }

    // Ensure directory exists
    await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });

    // Save to file
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(newSettings, null, 2));

    // Cache in Redis for quick access
    await RedisService.set('settings', JSON.stringify(newSettings));

    res.json({
      success: true,
      settings: newSettings,
      message: 'Settings updated successfully'
    });
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Reset settings to defaults
router.post('/reset', async (req, res) => {
  const { section } = req.body;

  try {
    let settings = DEFAULT_SETTINGS;

    if (section && DEFAULT_SETTINGS[section]) {
      // Reset only specific section
      const currentData = await fs.readFile(SETTINGS_FILE, 'utf8');
      const currentSettings = JSON.parse(currentData);
      settings = {
        ...currentSettings,
        [section]: DEFAULT_SETTINGS[section]
      };
    }

    // Save to file
    await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));

    // Update cache
    await RedisService.set('settings', JSON.stringify(settings));

    res.json({
      success: true,
      settings,
      message: section 
        ? `Settings section '${section}' reset to defaults`
        : 'All settings reset to defaults'
    });
  } catch (error) {
    console.error('Error resetting settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Export settings
router.get('/export', async (req, res) => {
  try {
    const data = await fs.readFile(SETTINGS_FILE, 'utf8');
    const settings = JSON.parse(data);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="workspace-settings.json"');
    res.send(JSON.stringify(settings, null, 2));
  } catch (error) {
    console.error('Error exporting settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Import settings
router.post('/import', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const importedSettings = req.body;

    // Validate
    const validation = validateSettings(importedSettings);
    if (!validation.valid) {
      return res.status(400).json({
        error: 'Invalid settings format',
        errors: validation.errors
      });
    }

    // Merge with defaults to ensure all fields exist
    const settings = deepMerge(DEFAULT_SETTINGS, importedSettings);

    // Save
    await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2));

    // Update cache
    await RedisService.set('settings', JSON.stringify(settings));

    res.json({
      success: true,
      settings,
      message: 'Settings imported successfully'
    });
  } catch (error) {
    console.error('Error importing settings:', error);
    res.status(500).json({ error: error.message });
  }
});

// Test LLM Gateway connection
router.post('/test/llm', async (req, res) => {
  const { url = null, model = 'gpt-4o' } = req.body;

  try {
    const axios = require('axios');
    const testUrl = url || process.env.LLM_GATEWAY_URL || 'http://llm-gateway:3010';
    
    const response = await axios.post(`${testUrl}/api/tokenize`, {
      text: 'Hello, this is a test message.',
      model
    }, {
      timeout: 5000
    });

    res.json({
      success: true,
      connected: true,
      url: testUrl,
      model,
      response: response.data
    });
  } catch (error) {
    res.json({
      success: false,
      connected: false,
      error: error.message
    });
  }
});

// Test GitHub Hub connection
router.post('/test/github-hub', async (req, res) => {
  const { url = null } = req.body;

  try {
    const axios = require('axios');
    const testUrl = url || process.env.GITHUB_HUB_URL || 'http://github-hub-module:3002';
    
    const response = await axios.get(`${testUrl}/api/health`, {
      timeout: 5000
    });

    res.json({
      success: true,
      connected: true,
      url: testUrl,
      response: response.data
    });
  } catch (error) {
    res.json({
      success: false,
      connected: false,
      error: error.message
    });
  }
});

// Helper functions
function deepMerge(target, source) {
  const output = { ...target };
  
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        output[key] = deepMerge(target[key], source[key]);
      } else {
        output[key] = source[key];
      }
    } else {
      output[key] = source[key];
    }
  }
  
  return output;
}

function validateSettings(settings) {
  const errors = [];

  // Validate numeric ranges
  if (settings.snapshots) {
    if (settings.snapshots.maxPerRepo < 1 || settings.snapshots.maxPerRepo > 1000) {
      errors.push('snapshots.maxPerRepo must be between 1 and 1000');
    }
    if (settings.snapshots.retentionDays < 1 || settings.snapshots.retentionDays > 365) {
      errors.push('snapshots.retentionDays must be between 1 and 365');
    }
  }

  if (settings.workspace) {
    if (settings.workspace.lockTTL < 60 || settings.workspace.lockTTL > 86400) {
      errors.push('workspace.lockTTL must be between 60 and 86400 seconds');
    }
    if (settings.workspace.maxFileSize < 1048576 || settings.workspace.maxFileSize > 1073741824) {
      errors.push('workspace.maxFileSize must be between 1MB and 1GB');
    }
  }

  if (settings.ai) {
    if (settings.ai.temperature < 0 || settings.ai.temperature > 2) {
      errors.push('ai.temperature must be between 0 and 2');
    }
    if (settings.ai.maxTokens < 1 || settings.ai.maxTokens > 4000) {
      errors.push('ai.maxTokens must be between 1 and 4000');
    }
  }

  // Validate enums
  const validThemes = ['light', 'dark', 'auto'];
  if (settings.ui && !validThemes.includes(settings.ui.theme)) {
    errors.push(`ui.theme must be one of: ${validThemes.join(', ')}`);
  }

  const validDiffViews = ['split', 'unified'];
  if (settings.ui && !validDiffViews.includes(settings.ui.diffView)) {
    errors.push(`ui.diffView must be one of: ${validDiffViews.join(', ')}`);
  }

  const validCommitStyles = ['conventional', 'simple', 'detailed'];
  if (settings.ai && !validCommitStyles.includes(settings.ai.commitStyle)) {
    errors.push(`ai.commitStyle must be one of: ${validCommitStyles.join(', ')}`);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = router;
