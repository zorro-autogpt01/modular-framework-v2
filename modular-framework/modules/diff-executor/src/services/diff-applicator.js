const fs = require('fs-extra');
const path = require('path');
const diff = require('diff');
const SyntaxValidator = require('./syntax-validator');
const LLMRepairService = require('./llm-repair');

class DiffApplicator {
  constructor({ stagingManager, logger, llmGatewayUrl, enableValidation = true }) {
    this.stagingManager = stagingManager;
    this.logger = logger;
    this.enableValidation = enableValidation;
    
    this.syntaxValidator = new SyntaxValidator({ logger });
    this.llmRepair = new LLMRepairService({ 
      llmGatewayUrl: llmGatewayUrl || process.env.LLM_GATEWAY_URL,
      logger 
    });
  }

  async applyDiff(diffContent, targetFiles, stagingPath) {
    const results = {
      success: true,
      appliedFiles: [],
      errors: [],
      validationResults: null,
      repairs: []
    };

    try {
      // First pass: Apply patches
      const patches = this.parseUnifiedDiff(diffContent);
      
      for (const patch of patches) {
        const targetFile = targetFiles.find(f => 
          f.filePath === patch.file || 
          f.filePath.endsWith(patch.file)
        );
        
        if (!targetFile) {
          this.logger.warn(`No target file found for patch: ${patch.file}`);
          results.errors.push(`No target file found for patch: ${patch.file}`);
          continue;
        }
        
        const filePath = path.join(
          stagingPath, 
          targetFile.connectionId, 
          targetFile.repoName, 
          targetFile.filePath
        );
        
        try {
          let content = '';
          if (await fs.pathExists(filePath)) {
            content = await fs.readFile(filePath, 'utf8');
          }
          
          const patched = this.applyPatch(content, patch);
          await fs.writeFile(filePath, patched);
          
          results.appliedFiles.push({
            ...targetFile,
            stagingPath: filePath,
            linesAdded: patch.additions,
            linesRemoved: patch.deletions
          });
          
          this.logger.info(`Applied patch to ${filePath}`);
        } catch (err) {
          this.logger.error(`Error applying patch to ${filePath}:`, err);
          results.errors.push(`Failed to apply patch to ${targetFile.filePath}: ${err.message}`);
          results.success = false;
        }
      }
      
      // Second pass: Validate syntax if enabled
      if (this.enableValidation && results.appliedFiles.length > 0) {
        const validationResults = await this.syntaxValidator.validateFiles(
          stagingPath,
          results.appliedFiles
        );
        
        results.validationResults = validationResults;
        
        if (!validationResults.allValid) {
          this.logger.warn('Syntax validation failed, attempting LLM repair');
          
          // Attempt repair
          const repairs = await this.llmRepair.repairAndRetry(
            stagingPath,
            results.appliedFiles,
            diffContent,
            validationResults
          );
          
          results.repairs = repairs;
          
          // Apply repaired patches
          for (const repair of repairs) {
            if (repair.success) {
              const targetFile = results.appliedFiles.find(f => f.filePath === repair.file);
              if (targetFile) {
                try {
                  // Parse and apply the repaired patch
                  const repairedPatches = this.parseUnifiedDiff(repair.repairedPatch);
                  
                  for (const repairedPatch of repairedPatches) {
                    const filePath = targetFile.stagingPath;
                    let content = '';
                    
                    // Read original content again
                    const originalPath = path.join('/workspace/repos', targetFile.connectionId, targetFile.repoName, targetFile.filePath);
                    if (await fs.pathExists(originalPath)) {
                      content = await fs.readFile(originalPath, 'utf8');
                    }
                    
                    const patched = this.applyPatch(content, repairedPatch);
                    await fs.writeFile(filePath, patched);
                    
                    this.logger.info(`Applied repaired patch to ${filePath}`);
                  }
                  
                  // Re-validate after repair
                  const revalidation = await this.syntaxValidator.validateFile(
                    targetFile.filePath,
                    await fs.readFile(targetFile.stagingPath, 'utf8')
                  );
                  
                  repair.revalidation = revalidation;
                } catch (err) {
                  this.logger.error(`Failed to apply repaired patch for ${repair.file}:`, err);
                  repair.applyError = err.message;
                }
              }
            }
          }
          
          // Check if all repairs were successful
          const allRepairsSuccessful = repairs.every(r => 
            r.success && r.revalidation && r.revalidation.valid
          );
          
          if (!allRepairsSuccessful) {
            results.success = false;
            results.error = 'Some files still have syntax errors after repair attempt';
          }
        }
      }
      
      if (results.errors.length > 0) {
        results.success = false;
        results.error = results.errors.join('; ');
      }
      
      return results;
    } catch (error) {
      this.logger.error('Error applying diff:', error);
      return {
        success: false,
        error: error.message,
        appliedFiles: []
      };
    }
  }

  parseUnifiedDiff(diffText) {
    const patches = [];
    const lines = diffText.split('\n');
    let currentPatch = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        if (line.startsWith('+++ ')) {
          const file = line.substring(4).split(/\s+/)[0].replace(/^[ab]\//, '');
          currentPatch = {
            file,
            hunks: [],
            additions: 0,
            deletions: 0
          };
          patches.push(currentPatch);
        }
      } 
      else if (line.startsWith('@@') && currentPatch) {
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          const hunk = {
            oldStart: parseInt(match[1]),
            oldLines: parseInt(match[2] || 1),
            newStart: parseInt(match[3]),
            newLines: parseInt(match[4] || 1),
            lines: []
          };
          
          i++;
          while (i < lines.length && !lines[i].startsWith('@@') && 
                 !lines[i].startsWith('--- ') && !lines[i].startsWith('+++ ')) {
            const hunkLine = lines[i];
            if (hunkLine.startsWith('+')) {
              currentPatch.additions++;
              hunk.lines.push({ type: 'add', content: hunkLine.substring(1) });
            } else if (hunkLine.startsWith('-')) {
              currentPatch.deletions++;
              hunk.lines.push({ type: 'del', content: hunkLine.substring(1) });
            } else if (hunkLine.startsWith(' ')) {
              hunk.lines.push({ type: 'normal', content: hunkLine.substring(1) });
            }
            i++;
          }
          i--;
          
          currentPatch.hunks.push(hunk);
        }
      }
    }
    
    return patches;
  }

  applyPatch(originalContent, patch) {
    const originalLines = originalContent.split('\n');
    const resultLines = [...originalLines];
    
    for (let i = patch.hunks.length - 1; i >= 0; i--) {
      const hunk = patch.hunks[i];
      const startLine = hunk.oldStart - 1;
      
      const toRemove = [];
      const toAdd = [];
      
      for (const line of hunk.lines) {
        if (line.type === 'del') {
          toRemove.push(line.content);
        } else if (line.type === 'add') {
          toAdd.push(line.content);
        }
      }
      
      resultLines.splice(startLine, toRemove.length, ...toAdd);
    }
    
    return resultLines.join('\n');
  }
}

module.exports = DiffApplicator;