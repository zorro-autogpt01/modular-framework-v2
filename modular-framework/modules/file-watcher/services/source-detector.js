// Source Detector
// Detects what caused file changes (git, ssh, editor, etc.)

const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');

class SourceDetector {
  constructor() {
    this.gitOperationCache = new Map(); // Cache recent git operations
    this.cacheTimeout = 5000; // 5 seconds
  }

  /**
   * Detect the source of file changes
   */
  async detectSource(connection_id, repo_name, repo_path, filePaths) {
    try {
      // Check if this is a git operation
      const gitSource = await this.detectGitOperation(repo_path, filePaths);
      if (gitSource) {
        return gitSource;
      }

      // Check if multiple files changed (likely batch operation)
      if (filePaths.length > 5) {
        return {
          type: 'batch',
          operation: 'multiple_files',
          confidence: 'medium'
        };
      }

      // Check for common patterns
      const patternSource = this.detectPatterns(filePaths);
      if (patternSource) {
        return patternSource;
      }

      // Default to unknown
      return {
        type: 'unknown',
        operation: 'file_change',
        confidence: 'low'
      };

    } catch (error) {
      console.error('Error detecting source:', error);
      return {
        type: 'unknown',
        operation: 'error',
        confidence: 'low'
      };
    }
  }

  /**
   * Detect if changes are from git operations
   */
  async detectGitOperation(repo_path, filePaths) {
    try {
      // Check cache first
      const cached = this.getFromCache(repo_path);
      if (cached) {
        return cached;
      }

      // Check if this is a git repository
      const isGitRepo = await this.isGitRepository(repo_path);
      if (!isGitRepo) {
        return null;
      }

      // Check for recent git operations
      const gitLog = await this.getRecentGitLog(repo_path);
      
      // Check if files match recent commit
      if (gitLog.recentCommit) {
        const commitFiles = await this.getCommitFiles(repo_path, gitLog.recentCommit);
        const matchingFiles = filePaths.filter(f => 
          commitFiles.some(cf => cf.includes(f) || f.includes(cf))
        );

        if (matchingFiles.length > 0) {
          const source = {
            type: 'git',
            operation: 'commit',
            confidence: 'high',
            metadata: {
              commit: gitLog.recentCommit,
              author: gitLog.author,
              message: gitLog.message
            }
          };
          this.addToCache(repo_path, source);
          return source;
        }
      }

      // Check for pull/fetch operations
      const pullOperation = await this.detectPullOperation(repo_path);
      if (pullOperation) {
        this.addToCache(repo_path, pullOperation);
        return pullOperation;
      }

      // Check for merge operations
      const mergeOperation = await this.detectMergeOperation(repo_path);
      if (mergeOperation) {
        this.addToCache(repo_path, mergeOperation);
        return mergeOperation;
      }

      // Check for checkout operations
      const checkoutOperation = await this.detectCheckoutOperation(repo_path);
      if (checkoutOperation) {
        this.addToCache(repo_path, checkoutOperation);
        return checkoutOperation;
      }

      // Check for stash operations
      const stashOperation = await this.detectStashOperation(repo_path);
      if (stashOperation) {
        this.addToCache(repo_path, stashOperation);
        return stashOperation;
      }

      return null;

    } catch (error) {
      console.error('Error detecting git operation:', error);
      return null;
    }
  }

  /**
   * Check if directory is a git repository
   */
  async isGitRepository(repo_path) {
    try {
      const gitDir = path.join(repo_path, '.git');
      const stats = await fs.stat(gitDir);
      return stats.isDirectory();
    } catch (error) {
      return false;
    }
  }

  /**
   * Get recent git log
   */
  async getRecentGitLog(repo_path) {
    try {
      const { stdout } = await execPromise(
        'git log -1 --pretty=format:"%H|%an|%s"',
        { cwd: repo_path }
      );

      if (stdout) {
        const [commit, author, message] = stdout.split('|');
        return { recentCommit: commit, author, message };
      }

      return {};
    } catch (error) {
      return {};
    }
  }

  /**
   * Get files from a commit
   */
  async getCommitFiles(repo_path, commitHash) {
    try {
      const { stdout } = await execPromise(
        `git diff-tree --no-commit-id --name-only -r ${commitHash}`,
        { cwd: repo_path }
      );

      return stdout.trim().split('\n').filter(f => f);
    } catch (error) {
      return [];
    }
  }

  /**
   * Detect pull operation
   */
  async detectPullOperation(repo_path) {
    try {
      // Check FETCH_HEAD modification time
      const fetchHeadPath = path.join(repo_path, '.git', 'FETCH_HEAD');
      const stats = await fs.stat(fetchHeadPath);
      const ageMs = Date.now() - stats.mtimeMs;

      if (ageMs < 10000) { // Within 10 seconds
        const { stdout } = await execPromise(
          'git log -1 FETCH_HEAD --pretty=format:"%H|%an|%s"',
          { cwd: repo_path }
        );

        const [commit, author, message] = stdout.split('|');
        return {
          type: 'git',
          operation: 'pull',
          confidence: 'high',
          metadata: { commit, author, message }
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Detect merge operation
   */
  async detectMergeOperation(repo_path) {
    try {
      const mergeHeadPath = path.join(repo_path, '.git', 'MERGE_HEAD');
      try {
        await fs.access(mergeHeadPath);
        return {
          type: 'git',
          operation: 'merge',
          confidence: 'high'
        };
      } catch {
        // MERGE_HEAD doesn't exist, not a merge
        return null;
      }
    } catch (error) {
      return null;
    }
  }

  /**
   * Detect checkout operation
   */
  async detectCheckoutOperation(repo_path) {
    try {
      // Check HEAD modification time
      const headPath = path.join(repo_path, '.git', 'HEAD');
      const stats = await fs.stat(headPath);
      const ageMs = Date.now() - stats.mtimeMs;

      if (ageMs < 5000) { // Within 5 seconds
        const { stdout } = await execPromise(
          'git rev-parse --abbrev-ref HEAD',
          { cwd: repo_path }
        );

        return {
          type: 'git',
          operation: 'checkout',
          confidence: 'medium',
          metadata: { branch: stdout.trim() }
        };
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Detect stash operation
   */
  async detectStashOperation(repo_path) {
    try {
      const { stdout } = await execPromise(
        'git reflog -1 stash --pretty=format:"%gd|%gs"',
        { cwd: repo_path }
      );

      if (stdout) {
        const [ref, message] = stdout.split('|');
        // Check if stash is recent
        const { stdout: timestamp } = await execPromise(
          `git show -s --format=%ct ${ref}`,
          { cwd: repo_path }
        );

        const ageSeconds = Math.floor(Date.now() / 1000) - parseInt(timestamp);
        if (ageSeconds < 10) {
          return {
            type: 'git',
            operation: 'stash',
            confidence: 'medium',
            metadata: { message }
          };
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Detect patterns in file paths
   */
  detectPatterns(filePaths) {
    // Check for package manager files
    const packageFiles = ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];
    if (filePaths.some(f => packageFiles.includes(path.basename(f)))) {
      return {
        type: 'package_manager',
        operation: 'dependency_update',
        confidence: 'medium'
      };
    }

    // Check for build output files
    if (filePaths.every(f => f.startsWith('dist/') || f.startsWith('build/'))) {
      return {
        type: 'build',
        operation: 'compilation',
        confidence: 'medium'
      };
    }

    // Check for test files
    if (filePaths.every(f => f.includes('test') || f.includes('spec'))) {
      return {
        type: 'testing',
        operation: 'test_execution',
        confidence: 'medium'
      };
    }

    return null;
  }

  /**
   * Add to cache
   */
  addToCache(repo_path, source) {
    this.gitOperationCache.set(repo_path, {
      source,
      timestamp: Date.now()
    });

    // Clear after timeout
    setTimeout(() => {
      this.gitOperationCache.delete(repo_path);
    }, this.cacheTimeout);
  }

  /**
   * Get from cache
   */
  getFromCache(repo_path) {
    const cached = this.gitOperationCache.get(repo_path);
    if (cached) {
      const age = Date.now() - cached.timestamp;
      if (age < this.cacheTimeout) {
        return cached.source;
      }
    }
    return null;
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.gitOperationCache.clear();
  }
}

module.exports = SourceDetector;