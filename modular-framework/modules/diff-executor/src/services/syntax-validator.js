const fs = require('fs-extra');
const path = require('path');
const acorn = require('acorn');
const { parse: parseTypeScript } = require('@typescript-eslint/typescript-estree');

class SyntaxValidator {
  constructor({ logger }) {
    this.logger = logger;
  }

  async validateFile(filePath, content) {
    const ext = path.extname(filePath).toLowerCase();
    
    switch(ext) {
      case '.js':
      case '.jsx':
      case '.mjs':
        return this.validateJavaScript(content, filePath);
      case '.ts':
      case '.tsx':
        return this.validateTypeScript(content, filePath);
      default:
        return { valid: true, skipped: true, reason: 'Unsupported file type' };
    }
  }

  validateJavaScript(content, filePath) {
    try {
      acorn.parse(content, {
        ecmaVersion: 'latest',
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowAwaitOutsideFunction: true,
        allowSuperOutsideMethod: true,
        allowHashBang: true,
        locations: true
      });
      
      this.logger.info(`JavaScript validation passed: ${filePath}`);
      return { valid: true };
    } catch (error) {
      this.logger.warn(`JavaScript validation failed: ${filePath}`, error.message);
      return {
        valid: false,
        error: error.message,
        line: error.loc ? error.loc.line : null,
        column: error.loc ? error.loc.column : null,
        type: 'javascript'
      };
    }
  }

  validateTypeScript(content, filePath) {
    try {
      parseTypeScript(content, {
        loc: true,
        range: true,
        tokens: true,
        comment: true,
        errorOnUnknownASTType: true,
        jsx: filePath.endsWith('.tsx'),
        useJSXTextNode: true
      });
      
      this.logger.info(`TypeScript validation passed: ${filePath}`);
      return { valid: true };
    } catch (error) {
      this.logger.warn(`TypeScript validation failed: ${filePath}`, error.message);
      
      // Parse TypeScript error
      let line = null;
      let column = null;
      const lineMatch = error.message.match(/\((\d+):(\d+)\)/);
      if (lineMatch) {
        line = parseInt(lineMatch[1]);
        column = parseInt(lineMatch[2]);
      }
      
      return {
        valid: false,
        error: error.message,
        line,
        column,
        type: 'typescript'
      };
    }
  }

  async validateFiles(stagingPath, files) {
    const results = [];
    let allValid = true;
    
    for (const file of files) {
      const fullPath = path.join(stagingPath, file.connectionId, file.repoName, file.filePath);
      
      if (await fs.pathExists(fullPath)) {
        const content = await fs.readFile(fullPath, 'utf8');
        const result = await this.validateFile(file.filePath, content);
        
        results.push({
          file: file.filePath,
          ...result
        });
        
        if (!result.valid && !result.skipped) {
          allValid = false;
        }
      }
    }
    
    return { allValid, results };
  }
}

module.exports = SyntaxValidator;