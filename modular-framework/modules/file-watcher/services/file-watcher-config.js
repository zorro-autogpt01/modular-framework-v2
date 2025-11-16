// File Watcher Configuration
// Customize snapshot behavior and file monitoring

module.exports = {
  // Debouncing - wait this long after last change before creating snapshot
  debounceTime: 10000, // 10 seconds in milliseconds

  // History limits
  maxFileHistory: 100,   // Max snapshots per file
  maxRepoHistory: 1000,  // Max snapshots per repository

  // File size limits
  maxFileSize: 10485760, // 10MB - skip files larger than this
  includeBinaryFiles: false, // Whether to snapshot binary files

  // Ignore patterns (glob patterns)
  ignorePatterns: [
    // Version control
    '.git/**',
    '.svn/**',
    '.hg/**',
    
    // Dependencies
    'node_modules/**',
    'vendor/**',
    'bower_components/**',
    
    // Build outputs
    'dist/**',
    'build/**',
    'out/**',
    'coverage/**',
    'target/**',
    '.next/**',
    '.nuxt/**',
    
    // IDE and editor files
    '.vscode/**',
    '.idea/**',
    '.vs/**',
    '*.swp',
    '*.swo',
    '*.swn',
    '*~',
    '.DS_Store',
    'Thumbs.db',
    
    // Logs and temporary files
    '*.log',
    '*.tmp',
    '*.temp',
    '*.bak',
    '*.backup',
    '*.old',
    
    // Compiled and minified files
    '*.min.js',
    '*.min.css',
    '*.map',
    
    // Cache directories
    '.cache/**',
    '__pycache__/**',
    '*.pyc',
    '.pytest_cache/**',
    
    // OS files
    '.Trash/**',
    '.Spotlight-V100/**',
    '.TemporaryItems/**',
    
    // Package manager locks (often auto-generated)
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'composer.lock',
    
    // Environment files (may contain secrets)
    '.env.local',
    '.env.*.local'
  ],

  // Diff settings
  diff: {
    contextLines: 3,        // Lines of context before/after changes
    unified: true,          // Support unified diff format
    split: true,            // Support split diff format
    inline: true,           // Support inline diff format
    syntax: true,           // Enable syntax highlighting in diffs
    maxPreviewLines: 10     // Max lines in hover preview
  },

  // UI settings
  ui: {
    defaultTimelineLimit: 100,      // Default snapshots to show
    hoverDelay: 300,                 // ms before showing hover diff
    batchCollapsedByDefault: true,   // Collapse batches initially
    showSourceIcons: true,           // Show git/ssh/editor icons
    enableSearch: true,              // Enable timeline search
    enableDateFilter: true           // Enable date range filter
  },

  // Performance
  performance: {
    batchInsertSize: 50,     // Insert snapshots in batches
    cleanupInterval: 3600000, // Cleanup old snapshots every hour (ms)
    indexInterval: 300000     // Rebuild search index every 5 min (ms)
  }
};