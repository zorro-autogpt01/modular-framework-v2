// Diff Generator
// Creates diffs between file versions in multiple formats

const Diff = require('diff');
const config = require('./file-watcher-config');

class DiffGenerator {
  /**
   * Generate diff between two versions of content
   */
  generate(oldContent, newContent, fileName) {
    const oldLines = oldContent.split('\n');
    const newLines = newContent.split('\n');
    
    // Calculate unified diff
    const unifiedDiff = Diff.createPatch(
      fileName,
      oldContent,
      newContent,
      '',
      '',
      { context: config.diff.contextLines }
    );

    // Calculate line-by-line diff for UI
    const changes = Diff.diffLines(oldContent, newContent);
    
    // Calculate statistics
    const stats = this.calculateStats(changes);

    // Generate preview (for hover tooltip)
    const preview = this.generatePreview(changes, oldLines, newLines);

    return {
      unified: unifiedDiff,
      changes: changes,
      stats: stats,
      preview: preview,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Calculate diff statistics
   */
  calculateStats(changes) {
    let additions = 0;
    let deletions = 0;
    let modifications = 0;

    for (const change of changes) {
      const lines = change.count || 0;
      
      if (change.added) {
        additions += lines;
      } else if (change.removed) {
        deletions += lines;
      }
    }

    // Count modifications (lines that were both added and removed)
    modifications = Math.min(additions, deletions);
    additions -= modifications;
    deletions -= modifications;

    return {
      additions,
      deletions,
      modifications,
      total: additions + deletions + modifications
    };
  }

  /**
   * Generate preview for hover tooltip
   */
  generatePreview(changes, oldLines, newLines) {
    const previewLines = [];
    let lineCount = 0;
    const maxLines = config.diff.maxPreviewLines;

    let oldLineNum = 0;
    let newLineNum = 0;

    for (const change of changes) {
      if (lineCount >= maxLines) break;

      const lines = change.value.split('\n').filter(l => l !== '');
      
      for (const line of lines) {
        if (lineCount >= maxLines) break;

        if (change.added) {
          previewLines.push({
            type: 'added',
            lineNum: ++newLineNum,
            content: line
          });
          lineCount++;
        } else if (change.removed) {
          previewLines.push({
            type: 'removed',
            lineNum: ++oldLineNum,
            content: line
          });
          lineCount++;
        } else {
          // Context line
          oldLineNum++;
          newLineNum++;
          previewLines.push({
            type: 'context',
            lineNum: newLineNum,
            content: line
          });
          lineCount++;
        }
      }
    }

    return previewLines;
  }

  /**
   * Generate split diff format
   */
  generateSplitDiff(oldContent, newContent) {
    const changes = Diff.diffLines(oldContent, newContent);
    const left = [];  // Old content
    const right = []; // New content

    let oldLineNum = 0;
    let newLineNum = 0;

    for (const change of changes) {
      const lines = change.value.split('\n').filter(l => l !== '');

      if (change.added) {
        // Only in new version (right side)
        for (const line of lines) {
          left.push({ lineNum: null, content: '', type: 'empty' });
          right.push({ lineNum: ++newLineNum, content: line, type: 'added' });
        }
      } else if (change.removed) {
        // Only in old version (left side)
        for (const line of lines) {
          left.push({ lineNum: ++oldLineNum, content: line, type: 'removed' });
          right.push({ lineNum: null, content: '', type: 'empty' });
        }
      } else {
        // In both versions (context)
        for (const line of lines) {
          left.push({ lineNum: ++oldLineNum, content: line, type: 'context' });
          right.push({ lineNum: ++newLineNum, content: line, type: 'context' });
        }
      }
    }

    return { left, right };
  }

  /**
   * Generate inline diff format (word-level diff)
   */
  generateInlineDiff(oldContent, newContent) {
    const changes = Diff.diffLines(oldContent, newContent);
    const lines = [];

    let lineNum = 0;

    for (const change of changes) {
      const contentLines = change.value.split('\n').filter(l => l !== '');

      for (const line of contentLines) {
        lineNum++;

        if (change.added) {
          lines.push({
            lineNum,
            type: 'added',
            content: line
          });
        } else if (change.removed) {
          lines.push({
            lineNum,
            type: 'removed',
            content: line
          });
        } else {
          lines.push({
            lineNum,
            type: 'context',
            content: line
          });
        }
      }
    }

    return lines;
  }

  /**
   * Generate word-level diff for a single line
   */
  generateWordDiff(oldLine, newLine) {
    const changes = Diff.diffWords(oldLine, newLine);
    const parts = [];

    for (const change of changes) {
      parts.push({
        value: change.value,
        type: change.added ? 'added' : (change.removed ? 'removed' : 'context')
      });
    }

    return parts;
  }

  /**
   * Detect file language for syntax highlighting
   */
  detectLanguage(fileName) {
    const ext = fileName.split('.').pop().toLowerCase();
    
    const languageMap = {
      'js': 'javascript',
      'jsx': 'javascript',
      'ts': 'typescript',
      'tsx': 'typescript',
      'py': 'python',
      'rb': 'ruby',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'go': 'go',
      'rs': 'rust',
      'swift': 'swift',
      'kt': 'kotlin',
      'sql': 'sql',
      'sh': 'bash',
      'bash': 'bash',
      'json': 'json',
      'xml': 'xml',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'yaml': 'yaml',
      'yml': 'yaml',
      'md': 'markdown',
      'txt': 'plaintext'
    };

    return languageMap[ext] || 'plaintext';
  }

  /**
   * Format diff for display with line numbers
   */
  formatDiffWithLineNumbers(diff, fileName) {
    const language = this.detectLanguage(fileName);
    const lines = diff.split('\n');
    const formatted = [];

    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // Parse hunk header
        const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
        if (match) {
          oldLine = parseInt(match[1]) - 1;
          newLine = parseInt(match[2]) - 1;
        }
        formatted.push({
          type: 'hunk',
          content: line,
          oldLine: null,
          newLine: null
        });
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
        newLine++;
        formatted.push({
          type: 'added',
          content: line.substring(1),
          oldLine: null,
          newLine: newLine
        });
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        oldLine++;
        formatted.push({
          type: 'removed',
          content: line.substring(1),
          oldLine: oldLine,
          newLine: null
        });
      } else if (line.startsWith(' ')) {
        oldLine++;
        newLine++;
        formatted.push({
          type: 'context',
          content: line.substring(1),
          oldLine: oldLine,
          newLine: newLine
        });
      } else {
        // File header or other metadata
        formatted.push({
          type: 'header',
          content: line,
          oldLine: null,
          newLine: null
        });
      }
    }

    return {
      language,
      lines: formatted
    };
  }
}

module.exports = DiffGenerator;