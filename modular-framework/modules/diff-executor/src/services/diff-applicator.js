const fs = require('fs-extra');
const path = require('path');
const diff = require('diff');

class DiffApplicator {
  constructor({ stagingManager, logger }) {
    this.stagingManager = stagingManager;
    this.logger = logger;
  }

  async applyDiff(diffContent, targetFiles, stagingPath) {
    const results = {
      success: true,
      appliedFiles: [],
      errors: []
    };

    try {
      // Use the library to parse the unified diff
      const patches = diff.parsePatch(diffContent);

      for (const patch of patches) {
        // Figure out the filename from the patch
        const rawName =
          patch.newFileName ||
          patch.oldFileName ||
          patch.fileName ||
          '';

        // Strip leading a/ or b/
        const patchFile = rawName.replace(/^a\//, '').replace(/^b\//, '');

        const targetFile = targetFiles.find(f =>
          f.filePath === patchFile ||
          f.filePath.endsWith('/' + patchFile)
        );

        if (!targetFile) {
          this.logger.warn(`No target file found for patch: ${patchFile}`);
          results.errors.push(`No target file found for patch: ${patchFile}`);
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

          // Apply patch using the library
          const patched = diff.applyPatch(content, patch);

          if (patched === false) {
            throw new Error(`Failed to apply patch for ${patchFile}`);
          }

          await fs.ensureDir(path.dirname(filePath));
          await fs.writeFile(filePath, patched, 'utf8');

          results.appliedFiles.push({
            ...targetFile,
            stagingPath: filePath,
            // Optional: you can approximate additions/deletions from hunks
            linesAdded: patch.hunks.reduce((sum, h) =>
              sum + h.lines.filter(l => l.startsWith('+')).length, 0),
            linesRemoved: patch.hunks.reduce((sum, h) =>
              sum + h.lines.filter(l => l.startsWith('-')).length, 0)
          });

          this.logger.info(`Applied patch to ${filePath}`);
        } catch (err) {
          this.logger.error(`Error applying patch to ${filePath}:`, err);
          results.errors.push(`Failed to apply patch to ${targetFile.filePath}: ${err.message}`);
          results.success = false;
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
}

module.exports = DiffApplicator;
